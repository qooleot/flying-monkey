"use strict";

const gpsDB = require('../gpsDB');
const Promise = require('bluebird');
const threeDR = require('../3DR');
const numerics = require('../numerics');

let keyId = null;
let separationVectors = {};
let home = null;
let modePending = null;
let goal = { serial:0 };
let isManuvering = false;
let isRecording = false;
let flightData = {};
let mTime = (new Date()).valueOf();
let homeLocation = null;
let targetYaw = null;
let targetVelocity = null;

function recordFlightData(gpsObj,now)
{
  if(flightData[gpsObj.id] == null) flightData[gpsObj.id] = { paths:[], current:[] };

  let flight = flightData[gpsObj.id];

  flight.current.push({ lat:gpsObj.src.current.lat, long:gpsObj.src.current.long, alt:gpsObj.src.current.alt, millis:now.valueOf() });
}

const rotateGimbal = Promise.coroutine(function *(keyDistance,alt)
{
  if(homeLocation == null) homeLocation = yield threeDR.getHomeLocation();
  if(homeLocation != null)
  {
    let pitch = Math.atan2(keyDistance,alt - homeLocation.alt)*180/Math.PI - 90;

    threeDR.rotateGimbal(pitch);
  }
});

const canSetVelocity = Promise.coroutine(function *(newVelocity)
{
  if(targetVelocity == null) return true;

  let similarity = yield numerics.compareVelocity(newVelocity,targetVelocity);

  if(simiarlity >= 0.997) return false;

  let currentVelocity = yield threeDR.getVelocity();

  similarity = yield numerics.compareVelocity(currentVelocity,targetVelocity);
  if(simiarlity >= 0.999) return false;
  return true;
});

const canSetYaw = Promise.coroutine(function *(newYaw)
{
  if(targetYaw == null) return true;

  let yawDiff = targetYaw - newYaw;

  if(yawDiff < 0) yawDiff += 360;
  if(yawDiff < 5) return false;

  let currentAttitude = yield threeDR.getAttitude();

  yawDiff = currentAttitude.yaw*180/Math.PI - targetYaw;

  if(yawDiff < 0) yawDiff += 360;
  if(yawDiff > 3) return false;
  return true;
});


const planParallelCourse = Promise.coroutine(function *(planData)
{
  let destLat = planData.target.lat;
  let destLong = planData.target.long;


  if(!isNaN(planData.target.vLat) && !isNaN(planData.target.vLong))
  {
    destLat += 2.5*planData.target.vLat;
    destLong += 2.5*planData.target.vLong;
  }
  else console.log("target velocity is NaN");

  if(planData.home.ve != null && planData.home.vn != null)
  {
    destLat -= 0.25*planData.home.vLat;
    destLong -= 0.25*planData.home.vLong;
  }

  let homeToFutureTargetAzmuth = yield numerics.forwardAzmuth(planData.home.lat,planData.home.long,destLat,destLong);
  let homeToFutureTargetDistance = yield numerics.haversine(planData.home.lat,planData.home.long,destLat,destLong);
  let speed = yield numerics.speed(homeToFutureTargetDistance);
  let homeToKeyAzmuth = yield numerics.forwardAzmuth(planData.home.lat,planData.home.long,planData.key.lat,planData.key.long);
  let homeToKeyDistance = yield numerics.haversine(planData.home.lat,planData.home.long,planData.key.lat,planData.key.long);

  if(homeToFutureTargetAzmuth < 0) homeToFutureTargetAzmuth += 2*Math.PI;
  if(homeToKeyAzmuth < 0) homeToKeyAzmuth += 2*Math.PI;

  let yaw = homeToKeyAzmuth*180/Math.PI;
  let vn = Math.cos(homeToFutureTargetAzmuth)*speed*0.8;
  let ve = Math.sin(homeToFutureTargetAzmuth)*speed*0.8;
  let res;

  console.log(`yaw = ${yaw} vn = ${vn} ve = ${ve}`);

  if(speed > 0.15 || planData.home.speed > 0.15)
  {
    threeDR.setVelocity(vn,ve,0);
    threeDR.setYaw(yaw);
  }
  else threeDR.setYaw(yaw);
  //yield rotateGimbal(homeToKeyDistance,planData.home.alt);
});

const planTetheredCourse = Promise.coroutine(function *(planData)
{
  let keyToHomeAzmuth = yield numerics.forwardAzmuth(planData.key.lat,planData.key.long,planData.home.lat,planData.home.long);
  let r = yield numerics.haversine(planData.key.lat,planData.key.long,planData.home.lat,planData.home.long);
  let s = 0;
  let theta = 0;
  let vn = 0,ve = 0;
  let homeToKeyAzmuth = keyToHomeAzmuth - Math.PI;

  if(keyToHomeAzmuth < 0) keyToHomeAzmuth += 2*Math.PI;
  if(homeToKeyAzmuth < 0) homeToKeyAzmuth += 2*Math.PI;
  if(!isNaN(planData.home.azmuth))
  {
    vn = Math.cos(planData.home.azmuth)*planData.home.speed;
    ve = Math.sin(planData.home.azmuth)*planData.home.speed;
  }

  if(!isNaN(planData.key.speed))
  {
    s = planData.key.speed;
    theta = keyToHomeAzmuth - planData.key.azmuth;
    if(theta < 0) theta += 2*Math.PI;
  }

  let deltaF = yield numerics.deltaF(r,theta,s);
  let LL = yield numerics.destination(planData.key.lat,planData.key.long,keyToHomeAzmuth - deltaF[1],r - deltaF[0]);
  let targetAzmuth = yield numerics.forwardAzmuth(planData.home.lat,planData.home.long,LL[0],LL[1]);
  let targetDistance = yield numerics.haversine(planData.home.lat,planData.home.long,LL[0],LL[1]);
  let now = new Date();
  let yaw = homeToKeyAzmuth*180/Math.PI;

  console.log(`s = ${s} deltaF = ${deltaF}`);
  //gpsDB.addGPSCoord("^","goal",now.valueOf(),LL[0],LL[1],planData.home.alt);

  //console.log(`r = ${r} ktoha = ${keyToHomeAzmuth*180/Math.PI} ka = ${planData.key.azmuth*180/Math.PI} theta = ${theta*180/Math.PI} s = ${s} deltaF = ${deltaF} LL = ${LL}`);
  //console.log(`r = ${r} ktoha = ${keyToHomeAzmuth*180/Math.PI} ka = ${planData.key.azmuth*180/Math.PI} theta = ${theta*180/Math.PI}`);
  //console.log(`s = ${s} deltaF = ${deltaF} LL = ${LL} targetAzmuth = ${targetAzmuth} targetDistance = ${targetDistance}`);
  //console.log(`homeLat = ${planData.home.lat} homeLong = ${planData.home.long} keyLat = ${planData.key.lat} keyLong = ${planData.key.long}`)

  vn += Math.cos(targetAzmuth)*targetDistance;
  ve += Math.sin(targetAzmuth)*targetDistance;

  console.log(`yaw = ${yaw} vn = ${vn} ve = ${ve}`);

  if(yield canSetVelocity({ vn:vn, ve:ve, vd:0 })) threeDR.setVelocity(vn,ve,0);
  if(yield canSetYaw(yaw)) threeDR.setYaw(yaw);
  //if(yield canSetGimbal(r)) yield rotateGimbal(r,planData.home.alt);
});

const assemblePlanData = Promise.coroutine(function *()
{
  mTime = (new Date()).valueOf();

  let homeState = goal.home;
  let targetState = goal.target;
  let keyState = goal.key;
  let latencyFactor = (mTime - goal.millis)/1000;

  if(latencyFactor > 1) latencyFactor = 1;

  let homeUpdated = yield numerics.destination(homeState.lat,homeState.long,homeState.azmuth,homeState.speed*latencyFactor);
  let keyUpdated = yield numerics.destination(keyState.lat,keyState.long,keyState.azmuth,keyState.speed*latencyFactor);
  let targetUpdated;

  if(targetState != null) targetUpdated = yield numerics.destination(targetState.lat,targetState.long,targetState.azmuth,targetState.speed*latencyFactor);

  //console.log(`latencyFactor = ${latencyFactor} compensation: hs = ${homeState.speed*latencyFactor} ts = ${targetState.speed*latencyFactor} ks = ${keyState.speed*latencyFactor}`)

  let planData =
  {
    home:
    {
      lat:homeUpdated[0],
      long:homeUpdated[1],
      alt:homeState.alt,
      vLat:homeState.vLat,
      vLong:homeState.vLong,
      vAlt:homeState.vAlt,
      speed:homeState.speed,
      azmuth:homeState.asmuth
    },
    key:
    {
      lat:keyUpdated[0],
      long:keyUpdated[1],
      alt:keyState.alt,
      vLat:keyState.vLat,
      vLong:keyState.vLong,
      vAlt:keyState.vAlt,
      speed:keyState.speed,
      azmuth:keyState.azmuth
    }
  };

  if(targetState != null)
  {
    planData.target =
    {
      lat:targetUpdated[0],
      long:targetUpdated[1],
      alt:targetState.alt,
      vLat:targetState.vLat,
      vLong:targetState.vLong,
      vAlt:targetState.vAlt,
      speed:targetState.speed,
      azmuth:targetState.azmuth
    }
  }
  return planData;
});

const manuver = Promise.coroutine(function *()
{
  let modeName = threeDR.modeName();

  if(modeName != 'RTL' && isManuvering && goal.serial >= 1 && modePending  == null && threeDR.isArmed())
  {
    if(modeName != 'GUIDED')
    {
      if(modePending == null)
      {
        modePending = 'GUIDED';
        threeDR.guided();
        yield threeDR.waitForMode('GUIDED');
        modePending = null;
      }
    }

    if(goal.plan == "parallel")
    {
      let planData = yield assemblePlanData();

      yield planParallelCourse(planData);
    }
    else if(goal.plan == "tether")
    {
      let planData = yield assemblePlanData();

      yield planTetheredCourse(planData);
    }
  }
  else if(!isManuvering || modeName == 'RTL')
  {
    if(goal != null && goal.plan != null) console.log(`discarding goal (${goal.plan})`);
    if(modeName == 'RTL')
    {
      isManuvering == false;
      separationVectors = {};
      keyId = null;
    }
  }
});

setInterval(manuver,300);

const updateGoal = Promise.coroutine(function *()
{
  let target = gpsDB.getLoc('x');
  let key = gpsDB.getLoc(keyId);

  if(home && home.src.current && key && key.src.current)
  {
    let goalSerial = goal.serial;
    let now = new Date();
    let homeState = home.src.current;
    let homeSpeed = yield numerics.haversine(homeState.lat,homeState.long,homeState.lat + homeState.vLat,homeState.long + homeState.vLong);
    let homeAzmuth = yield numerics.forwardAzmuth(homeState.lat,homeState.long,homeState.lat + homeState.vLat,homeState.long + homeState.vLong);
    let keyState = key.src.current;
    let keySpeed = yield numerics.haversine(keyState.lat,keyState.long,keyState.lat + keyState.vLat,keyState.long + keyState.vLong);
    let keyAzmuth = yield numerics.forwardAzmuth(keyState.lat,keyState.long,keyState.lat + keyState.vLat,keyState.long + keyState.vLong);
    let targetState;
    let targetSpeed;
    let targetAzmuth;

    if(homeAzmuth < 0) homeAzmuth += 2*Math.PI;
    if(keyAzmuth < 0) keyAzmuth += 2*Math.PI;
    if(target && target.src.current)
    {
      targetState = target.src.current;
      targetSpeed = yield numerics.haversine(targetState.lat,targetState.long,targetState.lat + targetState.vLat,targetState.long + targetState.vLong);
      targetAzmuth = yield numerics.forwardAzmuth(targetState.lat,targetState.long,targetState.lat + targetState.vLat,targetState.long + targetState.vLong);
      if(targetAzmuth < 0) targetAzmuth += 2*Math.PI;
    }

    if(goalSerial == goal.serial)
    {
      goal.serial++;
      goal.millis = now.valueOf()
      goal.home =
      {
        lat:homeState.lat,
        long:homeState.long,
        alt:homeState.alt,
        vLat:homeState.vLat,
        vLong:homeState.vLong,
        vAlt:homeState.vAlt,
        speed:homeSpeed,
        azmuth:homeAzmuth
      };
      goal.key =
      {
        lat:keyState.lat,
        long:keyState.long,
        alt:keyState.alt,
        vLat:keyState.vLat,
        vLong:keyState.vLong,
        vAlt:keyState.vAlt,
        speed:keySpeed,
        azmuth:keyAzmuth
      };
      if(target && target.src.current)
      {
        goal.target =
        {
          lat:targetState.lat,
          long:targetState.long,
          alt:targetState.alt,
          vLat:targetState.vLat,
          vLong:targetState.vLong,
          vAlt:targetState.vAlt,
          speed:targetSpeed,
          azmuth:targetAzmuth
        };
      }
    }
  }
});

gpsDB.addUpdate('*',Promise.coroutine(function *(gpsObj,prev)
{
  let now = new Date();

  home = gpsObj;
  if(isRecording) recordFlightData(gpsObj,now);
  if(isManuvering && goal.plan != null) yield updateGoal();
}));

const updateParallelTarget = Promise.coroutine(function *(gpsObj)
{
  let now = new Date();

  if(separationVectors[gpsObj.id] == null)
  {
    let azmuth = yield numerics.forwardAzmuth(gpsObj.src.current.lat,gpsObj.src.current.long,home.src.current.lat,home.src.current.long);
    let distance = yield numerics.haversine(gpsObj.src.current.lat,gpsObj.src.current.long,home.src.current.lat,home.src.current.long);

    separationVectors[gpsObj.id] =
    {
      azmuth:azmuth,
      distance:distance,
      alt:home.src.current.alt - gpsObj.src.current.alt
    };

/*
    separationVectors[gpsObj.id] =
    {
      vector:[home.src.current.lat - gpsObj.src.current.lat,home.src.current.long - gpsObj.src.current.long,home.src.current.alt - gpsObj.src.current.alt]
    };
    */

    gpsDB.addGPSCoord("x","target",now.valueOf(),home.src.current.lat,home.src.current.long,home.src.current.alt);
  }
  else
  {
    /*
    let translated =
    {
      lat:gpsObj.src.current.lat + separationVectors[gpsObj.id].vector[0],
      long:gpsObj.src.current.long + separationVectors[gpsObj.id].vector[1],
      alt:gpsObj.src.current.alt + separationVectors[gpsObj.id].vector[2]
    };
    */

    let LL = yield numerics.destination(gpsObj.src.current.lat,gpsObj.src.current.long,separationVectors[gpsObj.id].azmuth,separationVectors[gpsObj.id].distance);

    let translated =
    {
      lat:LL[0],
      long:LL[1],
      alt:gpsObj.src.current.alt + separationVectors[gpsObj.id].alt
    };

    gpsDB.addGPSCoord("x","target",now.valueOf(),translated.lat,translated.long,translated.alt);
  }
});

const deviceUpdate = Promise.coroutine(function *(gpsObj,prev)
{
  if(home != null && keyId == gpsObj.id)
  {
    if(goal.plan == "parallel") yield updateParallelTarget(gpsObj);
    if(goal.plan != null) updateGoal();
  }
});

const gotoTarget = Promise.coroutine(function *(track)
{
  let target = gpsDB.getLoc('x');

  if(target && target.src.current && threeDR.isArmed())
  {
    let modeName = threeDR.modeName();

    if(modeName != "RTL")
    {
      if(modeName != "GUIDED")
      {
        threeDR.guided();
        yield threeDR.waitForMode("GUIDED");
      }
      console.log("goto: " + `(${target.src.current.lat},${target.src.current.long},${home.src.current.alt}) 2.0`);
      if(track) isManuvering = true;
      threeDR.goto(target.src.current.lat,target.src.current.long,home.src.current.alt,2.0);
    }
  }
});

module.exports =
{
  archive: function(id)
  {
    if(id != null && flightData[id] != null && flightData[id].current.length != 0)
    {
      flightData[id].paths.push({ path:flightData[id].current });
      flightData[id].current = [];
    }
  },
  azmuth: function(id,azmuth)
  {
    if(id && separationVectors[id] != null) separationVectors[id].azmuth = azmuth;
  },
  getFlightPaths: function(id)
  {
    if(flightData[id] != null) return flightData[id];
    return null;
  },
  goto: function() { gotoTarget(false); },
  loiter: function() { threeDR.loiter(); },
  parallel: function(id)
  {
    if(keyId != null) gpsDB.clearUpdates(keyId);
    goal.plan = "parallel";
    keyId = id;
    separationVectors[id] = null;
    gpsDB.addUpdate(id,deviceUpdate);
  },
  tether: function(id)
  {
    if(keyId != null) gpsDB.clearUpdates(keyId);
    goal.plan = "tether";
    keyId = id;
    separationVectors[id] = null;
    gpsDB.addUpdate(id,deviceUpdate);
  },
  rtl: function() { threeDR.rtl(); },
  track: function() { isManuvering = true; },
  untrack: function() { isManuvering = false; }
}
