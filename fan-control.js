'use strict';

const fs         = require('fs-extra');
const log4js     = require('log4js');
const rpio       = require('rpio');

const RoomControl = require('./lib/RoomControl');

const {
  MqttClient,
  topics,
} = require('@joachimhb/smart-home-shared');

const {
  fanControl,
  fanSpeed,
  fanTrailingTime,
  fanMinRunTime,
  fanLightTimeout,
  fanMinHumidityThreshold,
  fanMaxHumidityThreshold,

  roomTemperature,
  roomHumidity,

  lightStatus,
} = topics;

rpio.init({mapping: 'gpio'});

const logger = log4js.getLogger();

logger.level = 'info';
logger.level = 'debug';

const lockFilePath = '/var/run/pigpio.pid';

try {
  // eslint-disable-next-line no-sync
  const stats = fs.statSync(lockFilePath);

  if(stats) {
    // eslint-disable-next-line no-sync
    fs.unlinkSync(lockFilePath);

    logger.warn(`Deleted lockfile [${lockFilePath}]`);
  }
} catch(err) {
  if(err.code !== 'ENOENT') {
    logger.error(`Failed to cleanup lockfile [${lockFilePath}]`, err);
  }
}

const dockerConfigPath = '../config/fan-control/config';
const localConfigPath = '../smart-home-setup/kammer/config/fan-control/config';

let config = null;

try {
  config = require(dockerConfigPath);
  logger.info(`Using config [${dockerConfigPath}]`);
} catch(err) {
  logger.trace('Config fallback', err);
  config = require(localConfigPath);
  logger.info(`Using config [${localConfigPath}]`);
}

(async function() {
  const mqttClient = new MqttClient({
    url: config.mqttBroker,
    logger,
  });

  const thisRooms = config.rooms.filter(room => config.controlledRoomIds.includes(room.id));

  const roomMap = {};

  for(const room of thisRooms) {
    roomMap[room.id] = new RoomControl({
      logger,
      room,
      mqttClient,
    });
  }

  const handleMqttMessage = async(topic, data) => {
    logger.trace('handleMqttMessage', topic, data);

    const [
      area,
      areaId,
      element,
      elementId,
      subArea,
    ] = topic.split('/');

    if(area === 'room' && element === 'fans') {
      roomMap[areaId][subArea](elementId, data);
    }
    if(area === 'room' && element === 'lights') {
      roomMap[areaId][element](elementId, data);
    }
    if(area === 'room' && ['humidity'].includes(element)) {
      roomMap[areaId][element](data);
    }
  };

  await mqttClient.init(handleMqttMessage);

  for(const room of thisRooms) {
    for(const fan of room.fans || []) {
      await mqttClient.subscribe(fanControl(room.id, fan.id));
      await mqttClient.subscribe(fanSpeed(room.id, fan.id));
      await mqttClient.subscribe(fanTrailingTime(room.id, fan.id));
      await mqttClient.subscribe(fanMinRunTime(room.id, fan.id));
      await mqttClient.subscribe(fanMinHumidityThreshold(room.id, fan.id));
      await mqttClient.subscribe(fanMaxHumidityThreshold(room.id, fan.id));
      await mqttClient.subscribe(fanLightTimeout(room.id, fan.id));
    }
    for(const light of room.lights || []) {
      await mqttClient.subscribe(lightStatus(room.id, light.id));
    }

    await mqttClient.subscribe(roomHumidity(room.id));
    await mqttClient.subscribe(roomTemperature(room.id));
  }
})();
