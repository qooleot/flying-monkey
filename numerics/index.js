"use strict";

const Promise = require('bluebird');
const program = require('commander');

let julia;
let kalman;
let nav_geo;

program
  .option('-h, --host [hostname]', 'hostname [localhost]',"localhost")
  .option('-p, --port [port]', 'port [3000]',"3000")
  .parse(process.argv);


/**
 * @callback stateCallback
 * @param {string} err
 * @param {state} predictedState The next state
 */

/**
 * @function initialGuess
 * @arg {array} initialObservation Array of [lat,long,alt]
 * @arg {vector} initialVariance: Array of [latVar,longVar,altVar]
 * @arg {stateCallback} callback
*/

/**
 * @function newModel
 * @arg processVariance:          The model process variance
 * @arg observationVariance::     The model observation variance
 * @ arg callback:                 function(err,model)
 */

/**
 * @function predict
 * @arg {model} model The model
 * @arg {state} state The current state
 * @arg {functiion} callback       function(err,predictedState)
 */

module.exports = function()
{
  if(program.host == "localhost")
  {
    if(julia == null)
    {
      julia = require('node-julia');
      julia.eval('push!(LOAD_PATH,"numerics")');
      kalman = julia.import('./numerics/kalman');
      nav_geo = julia.import('./numerics/nav_geo');
    }
  }
  else
  {
    var io = require('socket.io-client');
    var socket = io.connect('http://'+program.host+':' + program.port, {reconnect: true});

    socket.on('connect', function() {
      console.log('socket connected');
    });

    var socketJuliaBind = function(fnName, submitData, cb) {
      var allArgs = Array.from(submitData);
      var cb = allArgs.pop();

      socket.emit('drone-chan', 'drone1', {fnName: fnName, args: allArgs}, 
        function(responseData) {
          cb(null, responseData); 
        }
      );
    }

    nav_geo = {
      speed: function(data, cb) {
        cb();
      }
    }

    kalman = {
      initialGuess: function() { 
        socketJuliaBind('kalman.initialGuess', arguments);
      },
      newModel: function() {
        socketJuliaBind('kalman.newModel', arguments);
      },
      predict: function() {
        socketJuliaBind('kalman.predict', arguments);
      },
      extractMeanFromState: function() {
        socketJuliaBind('kalman.extractMeanFromState', arguments);
      },
      extractVarianceFromState: function() {
        socketJuliaBind('kalman.extractVarianceFromState', arguments);
      },
      update: function() {
        socketJuliaBind('kalman.update', arguments);
      }
    } 
  }

  let res =
  {
    compareVelocity: Promise.promisify(function(v1,v2)
    {
      let a = new Float64Array(3);
      let b = new Float64Array(3);

      a[0] = v1.vn;
      a[1] = v1.ve;
      a[2] = v1.vd;
      b[0] = v2.vn;
      b[1] = v2.ve;
      b[2] = v2.vd;
      nav_geo.haversine(a,b,done);
    }),
    deltaF1: Promise.promisify(function(r,theta,s,done)
    {
      let args = new Float64Array(3);

      args[0] = r;
      args[1] = theta;
      args[2] = s;
      nav_geo.deltaF1(args,done);
    }),
    deltaF2: Promise.promisify(function(r,theta,s,done)
    {
      let args = new Float64Array(3);

      args[0] = r;
      args[1] = theta;
      args[2] = s;
      nav_geo.deltaF2(args,done);
    }),
    destination: Promise.promisify(function(lat,long,azmuth,distance,done)
    {
      let args = new Float64Array(4);

      args[0] = lat;
      args[1] = long;
      args[2] = azmuth;
      args[3] = distance;
      nav_geo.destination(args,done);
    }),
    forwardAzmuth: Promise.promisify(function(lat1,long1,lat2,long2,done)
    {
      let args = new Float64Array(4);

      args[0] = lat1;
      args[1] = long1;
      args[2] = lat2;
      args[3] = long2;
      nav_geo.forwardAzmuth(args,done);
    }),
    haversine: Promise.promisify(function(lat1,long1,lat2,long2,done)
    {
      let args = new Float64Array(4);

      args[0] = lat1;
      args[1] = long1;
      args[2] = lat2;
      args[3] = long2;
      nav_geo.haversine(args,done);
    }),
    kalmanInitialGuess: Promise.promisify(kalman.initialGuess),
    kalmanNewModel: Promise.promisify(kalman.newModel),
    kalmanPredict: Promise.promisify(kalman.predict),
    kalmanStateMean: Promise.promisify(kalman.extractMeanFromState),
    kalmanStateVariance: Promise.promisify(kalman.extractVarianceFromState),
    kalmanUpdate: Promise.promisify(kalman.update),
    speed: Promise.promisify(nav_geo.speed)
  };

  return res;
}
