'use strict';

const _      = require('lodash');
const check  = require('check-types-2');
const ms     = require('millisecond');
const moment = require('moment');
const prettyMs = require('pretty-ms');

const {
  controls,
  sensors,
  topics,
} = require('@joachimhb/smart-home-shared');

const {
  roomHumidity,
  roomTemperature,
  lightStatus,
  fanSpeed,
} = topics;

const {Fan} = controls;
const {DHT22, Light} = sensors;

class RoomControl {
  constructor(params) {
    check.assert.object(params, 'params is not an object');
    check.assert.object(params.logger, 'params.logger is not an object');
    check.assert.object(params.mqttClient, 'params.mqttClient is not an object');
    check.assert.object(params.room, 'params.room is not an object');

    Object.assign(this, params);

    this.fansMap = {};
    this.lightsMap = {};
    this.fansTrailing = {};
    this.roomStatus = {
      fans: {},
      lights: {},
      humidity: {},
      temperature: {},
    };

    const {room, logger, mqttClient, fansMap, roomStatus, lightsMap} = this;

    for(const fan of room.fans || []) {
      fansMap[fan.id] = new Fan({
        logger,
        location: `${room.label}/${fan.label}`,
        ...fan,
      });

      roomStatus.fans[fan.id] = {
        control: {
          value: 'manual',
        },
        speed: {
          value: 'off',
        },
      };
    }

    for(const light of room.lights || []) {
      lightsMap[light.id] = new Light({
        logger,
        location: `${room.label}/${light.label}`,
        ...light,
        onChange: async value => {
          await mqttClient.publish(lightStatus(room.id, light.id), {value}, {retain: true});
        },
      });

      roomStatus.lights[light.id] = {
        value: {
          value: 'off',
        },
      };

      lightsMap[light.id].start();
    }

    if(room.dht22) {
      this.dht22 = new DHT22({
        logger,
        location: room.label,
        ...room.dht22,
        onHumidityChange: async value => {
          await mqttClient.publish(roomHumidity(room.id), {value}, {retain: true});
        },
        onTemperatureChange: async value => {
          await mqttClient.publish(roomTemperature(room.id), {value}, {retain: true});
        },
      });

      this.dht22.start();
    }

    setInterval(() => {
      this.updateFans();
    }, 1000);
  }

  async updateFans() {
    const {room, logger, roomStatus, fansMap, fansTrailing, mqttClient} = this;

    // console.log(JSON.stringify(roomStatus, null, 2))

    for(const fan of room.fans || []) {
      const location = `${room.label}/${fan.label}`;
      const humidity =   _.get(roomStatus, ['humidity', 'value']);

      const minHumidityThreshold = _.get(roomStatus, ['fans', fan.id, 'minHumidityThreshold', 'value'], fan.minHumidityThreshold);
      const maxHumidityThreshold = _.get(roomStatus, ['fans', fan.id, 'maxHumidityThreshold', 'value'], fan.maxHumidityThreshold);

      const minRunTime =   _.get(roomStatus, ['fans', fan.id, 'minRunTime', 'value'], fan.minRunTime);
      const lightTimeout = _.get(roomStatus, ['fans', fan.id, 'lightTimeout', 'value'], fan.lightTimeout);
      const trailingTime = _.get(roomStatus, ['fans', fan.id, 'trailingTime', 'value'], fan.trailingTime);

      const control = _.get(roomStatus, ['fans', fan.id, 'control', 'value'], 'manual');
      const speed = _.get(roomStatus, ['fans', fan.id, 'speed', 'value'], 'off');
      const speedSince = _.get(roomStatus, ['fans', fan.id, 'speed', 'since'], new Date());

      if(control === 'manual') {
        fansMap[fan.id][speed]();

        continue;
      }

      // fan should run at same speed for a minimum time
      if(speed !== 'off' && moment().diff(speedSince, 'millisecond') < ms(`${minRunTime}s`)) {
        logger.debug(`[${location}]:Keep running - ${minRunTime}s not reached`);

        continue;
      }

      // automatic handling

      let newSpeed = 'off';

      if(humidity) {
        const downToMinThreshold = minHumidityThreshold - 5;
        const downToMaxThreshold = maxHumidityThreshold - 10;

        if(humidity > maxHumidityThreshold) {
          newSpeed = 'max';
          logger.warn(`[${location}]: Fan - run [max] - humidity > ${maxHumidityThreshold}`);
        } else if(speed === 'max' && humidity > downToMaxThreshold) {
          newSpeed = 'max';
          // just wait...
          logger.warn(`[${location}]: Fan - keep running [max] - humidity > ${downToMaxThreshold}`);
        } else if(humidity > minHumidityThreshold) {
          newSpeed = 'min';
          logger.warn(`[${location}]: Fan - run [min] - humidity > ${minHumidityThreshold}`);
        } else if(speed === 'min' && humidity > downToMinThreshold) {
          newSpeed = 'min';
          // just wait...
          logger.warn(`[${location}]: Fan - keep running [min] - humidity > ${downToMinThreshold}`);
        }
      }

      let minLightOnSince = null;
      let maxLightOffSince = null;
      let anyLightOn = false;

      for(const lightId of fan.triggerLights) {
        const lightValue = _.get(roomStatus, ['lights', lightId, 'value']);

        if(lightValue === 'on') {
          const onSince = _.get(roomStatus, ['lights', lightId, 'since']);

          if(!minLightOnSince || onSince < minLightOnSince) {
            minLightOnSince = onSince;
          }

          anyLightOn = true;
        } else {
          const offSince = _.get(roomStatus, ['lights', lightId, 'since']);

          if(!maxLightOffSince || offSince > maxLightOffSince) {
            maxLightOffSince = offSince;
          }
        }
      }

      if(anyLightOn && minLightOnSince) {
        const lightsOnDuration = moment().diff(minLightOnSince, 'millisecond');

        logger.debug(`[${location}]:Light(s) on since ${prettyMs(lightsOnDuration)}`);

        if(lightsOnDuration > ms(`${lightTimeout}s`)) {
          logger.debug(`[${location}]:Light timeout of ${lightTimeout}s reached`);

          fansTrailing[fan.id] = true;
        }
      }

      if(!anyLightOn && fansTrailing[fan.id] && maxLightOffSince) {
        const lightsOffDuration = moment().diff(maxLightOffSince, 'millisecond');

        logger.debug(`[${location}]:Light(s) off since ${prettyMs(lightsOffDuration)}`);

        if(lightsOffDuration > ms(`${trailingTime}s`)) {
          logger.debug(`[${location}]:Trailing time of ${trailingTime}s reached`);

          fansTrailing[fan.id] = false;
        } else {
          logger.debug(`[${location}]:Keep trailing - trailing time of ${trailingTime}s not yet reached`);
        }
      }

      if(fansTrailing[fan.id]) {
        newSpeed = 'min';
      }

      if(speed !== newSpeed) {
        await mqttClient.publish(fanSpeed(room.id, fan.id), {value: newSpeed}, {retain: true});
      }

      fansMap[fan.id][newSpeed]();
    }
  }

  minHumidityThreshold(id, data) {
    _.set(this.roomStatus, ['fans', id, 'minHumidityThreshold'], data);

    this.updateFans();
  }

  maxHumidityThreshold(id, data) {
    _.set(this.roomStatus, ['fans', id, 'maxHumidityThreshold'], data);

    this.updateFans();
  }

  minRunTime(id, data) {
    _.set(this.roomStatus, ['fans', id, 'minRunTime'], data);

    this.updateFans();
  }

  lightTimeout(id, data) {
    _.set(this.roomStatus, ['fans', id, 'lightTimeout'], data);

    this.updateFans();
  }

  trailingTime(id, data) {
    _.set(this.roomStatus, ['fans', id, 'trailingTime'], data);

    this.updateFans();
  }

  control(id, data) {
    _.set(this.roomStatus, ['fans', id, 'control'], data);

    this.updateFans();
  }

  speed(id, data) {
    _.set(this.roomStatus, ['fans', id, 'speed'], data);

    this.updateFans();
  }

  lights(id, data) {
    _.set(this.roomStatus, ['lights', id], data);

    this.updateFans();
  }

  temperature(data) {
    _.set(this.roomStatus, ['temperature'], data);

    this.updateFans();
  }

  humidity(data) {
    _.set(this.roomStatus, ['humidity'], data);

    this.updateFans();
  }
}

module.exports = RoomControl;
