'use strict';

const utils = require('@iobroker/adapter-core');
const sucks = require('ecovacs-deebot');
const nodeMachineId = require('node-machine-id');
const EcoVacsAPI = sucks.EcoVacsAPI;
const VacBot = sucks.VacBot;

class EcovacsDeebot extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'ecovacs-deebot',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.vacbot = null;
        this.connectionFailed = false;
        this.retries = 0;
        this.deviceNumber = 0;
        this.nick = null;
    }

    async onReady() {
        this.createStates();
        // Reset the connection indicator during startup
        this.setState('info.connection', false);
        this.connect();
        this.subscribeStates('*');
    }

    onUnload(callback) {
        try {
            this.setState('info.connection', false);
            this.log.info('cleaned everything up...');
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed object changes
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange(id, obj) {
        if (obj) {
            // The object was changed
            this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            this.log.info(`object ${id} deleted`);
        }
    }

    onStateChange(id, state) {

        const stateOfId = this.getStateById(id);
        const timestamp = Math.floor(Date.now() / 1000);
        const date = this.formatDate(new Date(), 'TT.MM.JJJJ SS:mm:ss');

        if (this.getChannelById(id) !== 'history') {

            this.log.debug('state change: ' + state);

            this.setState('history.timestampOfLastStateChange', timestamp);
            this.setState('history.dateOfLastStateChange', date);

            if ((stateOfId !== 'connection') && (stateOfId !== 'error')) {
                this.setState('info.connection', true);
            }

            if ((stateOfId === 'error') && (this.connectionFailed)) {
                if (this.retries <= this.config.maxautoretries) {
                    setTimeout(() => {
                        this.reconnect();
                    }, this.config.retrypause);
                }
            }
        }

        if (state.ack) return;
        // control buttons
        const channel = this.getChannelById(id);
        if (channel === 'control') {
            this.log.info('run: ' + stateOfId);
            switch (stateOfId) {
                case 'clean':
                case 'stop':
                case 'edge':
                case 'spot':
                case 'charge':
                    this.vacbot.run(stateOfId);
                    break;
                default:
                    this.log.info('Unhandled control state: ' + stateOfId);
            }
        }
    }

    reconnect() {
        this.log.info('reconnecting ...');
        this.retries++;
        this.connect();
    }

    getChannelById(id) {
        const channel = id.split('.')[2];
        return channel;
    }

    getStateById(id) {
        const state = id.split('.')[3];
        return state;
    }

    async connect() {
        this.connectionFailed = false;
        this.setState('info.error', '');

        if ((!this.config.email) || (!this.config.password) || (!this.config.countrycode)) {
            this.error('Missing values in adapter config', true);
            return;
        }
        if (this.config.deviceNumber) {
            this.deviceNumber = this.config.deviceNumber;
        } else {
            this.log.info('Missing device Number in adapter config. Using value 0');
        }
        const password_hash = EcoVacsAPI.md5(this.config.password);
        const device_id = EcoVacsAPI.md5(nodeMachineId.machineIdSync());
        const countries = sucks.countries;
        const continent = countries[this.config.countrycode.toUpperCase()].continent.toLowerCase();

        const api = new EcoVacsAPI(device_id, this.config.countrycode, continent);
        api.connect(this.config.email, password_hash).then(() => {
            api.devices().then((devices) => {
                this.log.info('Devices:' + JSON.stringify(devices));
                const vacuum = devices[this.deviceNumber];
                this.nick = 'New Device ' + this.deviceNumber;
                if (vacuum.nick) {
                    this.nick = vacuum.nick;
                }
                if (vacuum.nick) {
                    this.nick = vacuum.nick;
                }
                this.setState('info.deviceName', this.nick);
                const protocol = (vacuum.company === 'eco-ng') ? 'MQTT' : 'XMPP';
                this.setState('info.deviceClass', protocol);
                this.setState('info.communicationProtocol', vacuum.company);
                this.vacbot = new VacBot(api.uid, EcoVacsAPI.REALM, api.resource, api.user_access_token, vacuum, continent);
                this.vacbot.on('ready', (event) => {
                    this.setState('info.connection', true);
                    this.retries = 0;
                    this.vacbot.on('ChargeState', (chargestatus) => {
                        const timestamp = Math.floor(Date.now() / 1000);
                        const date = this.formatDate(new Date(), 'TT.MM.JJJJ SS:mm:ss');
                        this.setState('info.chargestatus', chargestatus);
                        if ((chargestatus === 'returning') || (chargestatus === 'charging') || (chargestatus === 'idle')) {
                            this.setState('info.cleanstatus', '');
                            this.setState('history.timestampOfLastStartCharging', timestamp);
                            this.setState('history.dateOfLastStartCharging', date);
                        } else {
                            this.log.info('Unhandled chargestatus: ' + chargestatus);
                        }
                    });
                    this.vacbot.on('CleanReport', (cleanstatus) => {
                        const timestamp = Math.floor(Date.now() / 1000);
                        const date = this.formatDate(new Date(), 'TT.MM.JJJJ SS:mm:ss');
                        this.setState('info.cleanstatus', cleanstatus);
                        if ((cleanstatus === 'auto') || (cleanstatus === 'stop') || (cleanstatus === 'pause') || (cleanstatus === 'border') || (cleanstatus === 'spot')) {
                            this.setState('info.chargestatus', '');
                            this.setState('history.timestampOfLastStartCleaning', timestamp);
                            this.setState('history.dateOfLastStartCleaning', date);
                        } else {
                            this.log.info('Unhandled cleanstatus: ' + cleanstatus);
                        }
                    });
                    this.vacbot.on('BatteryInfo', (batterystatus) => {
                        this.setState('info.battery', Math.round(batterystatus * 100));
                    });
                });
                this.vacbot.connect_and_wait_until_ready();
            });
        }).catch((e) => {
            this.connectionFailed = true;
            this.error(e.message, true);
        });
    }

    error(message, stop) {
        if (stop) {
            this.setState('info.connection', false);
        }
        this.setState('info.error', message);
        this.log.error(message);
    }

    async createStates() {

        const buttons = new Map();
        buttons.set('clean', 'start automatic cleaning');
        buttons.set('edge', 'start edge cleaning');
        buttons.set('spot', 'start spot cleaning');
        buttons.set('stop', 'stop cleaning');
        buttons.set('charge', 'go back to charging station');
        for (const [objectName, name] of buttons) {
            await this.createObjectNotExists(
                'control.' + objectName, name,
                'boolean', 'button', true, '', '');
        }

        await this.createObjectNotExists(
            'info.deviceName', 'Name of the device',
            'string', 'text', false, '', '');
        await this.createObjectNotExists(
            'info.communicationProtocol', 'Communication protocol',
            'string', 'text', false, '', '');
        await this.createObjectNotExists(
            'info.deviceClass', 'Class number of the device',
            'string', 'text', false, '', '');
        await this.createObjectNotExists(
            'info.battery', 'Battery status',
            'integer', 'value.battery', false, '', '%');
        await this.createObjectNotExists(
            'info.connection', 'Connection status',
            'boolean', 'indicator.connected', false, false, '');
        await this.createObjectNotExists(
            'info.cleanstatus', 'Clean status',
            'string', 'indicator.status', false, '', '');
        await this.createObjectNotExists(
            'info.chargestatus', 'Charge status',
            'string', 'indicator.status', false, '', '');
        await this.createObjectNotExists(
            'info.error', 'Error messages',
            'string', 'indicator.error', false, '', '');

        // Timestamps
        await this.createObjectNotExists(
            'history.timestampOfLastStateChange', 'Timestamp of last state change',
            'integer', 'value.datetime', false, '', '');
        await this.createObjectNotExists(
            'history.dateOfLastStateChange', 'Human readable timestamp of last state change',
            'string', 'value.datetime', false, '', '');

        await this.createObjectNotExists(
            'history.timestampOfLastStartCleaning', 'Timestamp of last start cleaning',
            'integer', 'value.datetime', false, '', '');
        await this.createObjectNotExists(
            'history.dateOfLastStartCleaning', 'Human readable timestamp of last start cleaning',
            'string', 'value.datetime', false, '', '');

        await this.createObjectNotExists(
            'history.timestampOfLastStartCharging', 'Timestamp of last start charging',
            'integer', 'value.datetime', false, '', '');
        await this.createObjectNotExists(
            'history.dateOfLastStartCharging', 'Human readable timestamp of last start charging',
            'string', 'value.datetime', false, '', '');
    }

    async createObjectNotExists(id, name, type, role, write, def, unit) {
        await this.setObjectNotExists(id, {
            type: 'state',
            common: {
                name: name,
                type: type,
                role: role,
                read: true,
                write: write,
                def: def,
                unit: unit
            },
            native: {},
        });
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    module.exports = (options) => new EcovacsDeebot(options);
} else {
    new EcovacsDeebot();
}