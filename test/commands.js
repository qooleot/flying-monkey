"use strict";

const request = require('request');
const Promise = require('bluebird');

const sendCoord = Promise.promisify(function(url,id,name,millis,lat,long,alt,callback)
{
  request.post({
    url: url + 'log_gps',
    json: true,
    body:
    {
      device: { deviceId:id, deviceName:name },
      date:millis,
      lat:lat,
      long:long,
      alt:alt
    }
  },
  function (err,res,body) {
    callback(err);
  });
});

const getList = Promise.promisify(function(url,callback)
{
  request.post({
    url: url + 'list_ids',
    json: true
  },
  function (err,res,body) {
    callback(err,body);
  });
});

const send = Promise.coroutine(function*(url,id,name,lat,long,alt)
{
  let now = new Date();

  yield sendCoord(url,id,name,now.valueOf(),lat,long,alt);
});

const list = Promise.coroutine(function*(url)
{
  return yield getList(url);
});

module.exports = 
{
  send:send,
  list:list
};