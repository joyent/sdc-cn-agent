/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

var dns = require('dns');
var exec = require('child_process').exec;
var fs = require('fs');
var os = require('os');
var path = require('path');

var assert = require('assert-plus');
var async = require('async');
var backo2 = require('backo2');
var jsprim = require('jsprim');
var restify = require('restify');
var vasync = require('vasync');
var verror = require('verror');

var StatusReporter = require('./heartbeater');

var createHttpTaskDispatchFn
    = require('./task_agent/dispatch').createHttpTaskDispatchFn;
var TaskAgent = require('./task_agent/task_agent');

var DEFAULT_TASK_TIMEOUT_SECONDS = 60 * 60;
var HEARTBEAT_INTERVAL = 5000; // (milliseconds) interval on which to send msgs

//
// 1.6 chosen here mostly randomly, just so we try a bit more often initially
// than with the default value of 2. If a more scientific value is arrived at,
// feel free to change. Same goes for the other values here. These seemed like
// reasonable places to start, but production experience will likely lead to
// improvement opportunities. Nothing is magical about these values.
//
var REGISTER_RETRY_FACTOR = 1.6;
var REGISTER_RETRY_JITTER = 0.2;
var REGISTER_RETRY_MAX_DELAY_MS = 120 * 1000;
var REGISTER_RETRY_MIN_DELAY_MS = 500;

function App(options) {
    assert.object(options, 'options');
    assert.object(options.agentserver, 'options.agentserver');
    assert.object(options.backend, 'options.backend');
    assert.object(options.config, 'options.config');
    assert.optionalObject(options.env, 'options.env');
    assert.object(options.log, 'options.log');
    assert.object(options.sdc_config, 'options.sdc_config');
    assert.object(options.sysinfo, 'options.sysinfo');
    assert.string(options.tasklogdir, 'options.tasklogdir');
    assert.uuid(options.uuid, 'options.uuid');

    var packageJson =
        JSON.parse(fs.readFileSync(path.join(__dirname, '/../package.json'),
        'utf8'));

    this.options = options;
    if (!options.env) {
        options.env = {};
    }

    this.agentserver = options.agentserver;
    this.backend = options.backend;
    this.cnapiQueue = vasync.queue(sendToCnapi.bind(this), 1);
    this.config = options.config;
    this.log = options.log.child();
    this.registerBackoff = new backo2({
        factor: REGISTER_RETRY_FACTOR,
        jitter: REGISTER_RETRY_JITTER,
        max: REGISTER_RETRY_MAX_DELAY_MS,
        min: REGISTER_RETRY_MIN_DELAY_MS
    });
    this.sdc_config = options.sdc_config;
    this.statusQueued = false;
    this.sysinfo = options.sysinfo;
    this.sysinfoCount = 0;
    this.sysinfoQueued = false;
    // use the same user-agent format as vm-agent
    this.userAgent = 'cn-agent/' + packageJson.version +
        ' (node/' + process.versions.node + ')' +
        ' server/' + options.uuid;
    this.uuid = options.uuid;

    this.isUpdateHelper = false;
    if (process.env.SMF_FMRI === 'svc:/smartdc/agent/cn-agent-update:default') {
        // If we're the cn-agent-update service, we won't register with CNAPI
        // since the cn-agent service will do that and the cn-agent-update
        // service is only ever used to by cn-agent itself.
        this.isUpdateHelper = true;
    }

    // Ensure we have all the config required to connect to and use CNAPI.
    assert.object(this.config, 'this.config');
    assert.optionalObject(this.config.cnapi, 'this.config.cnapi');
    assert.string(this.sdc_config.dns_domain, 'this.sdc_config.dns_domain');
    assert.string(this.sdc_config.datacenter_name,
        'this.sdc_config.datacenter_name');
    assert.object(this.sysinfo, 'this.sysinfo');

    this.log.info('Started cn-agent for %s', this.uuid);
}


function shuffleArray(array) {
    for (var i = array.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
    return array;
}


App.prototype.createCnapiConnection = function createCnapiConnection(callback) {
    var self = this;

    var cnapiAddr = 'cnapi.' + self.sdc_config.datacenter_name + '.' +
        self.sdc_config.dns_domain;
    var url = (self.config.cnapi && self.config.cnapi.url) ||
        'http://' + cnapiAddr;

    var restifyOptions = {
        agent: false,
        connectTimeout: 5000,
        requestTimeout: 5000,
        userAgent: self.userAgent,
        url: url
    };

    self.log.info('Creating CNAPI connection to %s', url);
    self.cnapiClient = restify.createJsonClient(restifyOptions);

    callback();
};


App.prototype.updateAgents = function (callback) {
    var self = this;

    assert.object(self.cnapiClient, 'self.cnapiClient');

    self.backend.getAgents({
        serverUuid: self.uuid,
        sysinfo: self.sysinfo
    }, function gotAgents(err, agents) {
        if (err) {
            callback(new verror.VError('Cannot get agents image versions'));
            return;
        }

        self.log.info({ agents: agents }, 'Posting agents');
        self.cnapiClient.post('/servers/' + self.uuid, {
            agents: agents
        }, function (postErr) {
            if (postErr) {
                self.log.warn({ error: postErr },
                    'Error posting agents to cnapi');
            } else {
                self.log.info('Posted agents info to cnapi');
            }

            callback();
        });
    });
};

App.prototype.queueHeartbeat = function queueHeartbeat() {
    var self = this;

    self.cnapiQueue.push('heartbeat', function _onHeartbeated() {
        // Queue the next one 5s after this one completes.
        setTimeout(self.queueHeartbeat.bind(self), HEARTBEAT_INTERVAL);
    });
};

App.prototype.queueStatusUpdateIfNotAlreadyQueued =
function queueStatusUpdateIfNotAlreadyQueued() {
    var self = this;

    if (self.statusQueued === true) {
        self.log.debug('Already have a status update pending');
        return;
    }

    // Queue a status update
    self.statusQueued = true;
    self.cnapiQueue.push('status', function _onStatusUpdated() {
        self.statusQueued = false;
    });
};

App.prototype.queueSysinfoUpdateIfNotAlreadyQueued =
function queueSysinfoUpdateIfNotAlreadyQueued(callback) {
    assert.optionalFunc(callback, 'callback');

    var self = this;

    if (self.sysinfoQueued === true) {
        self.log.debug('Already have a sysinfo update pending');
        return;
    }

    // Queue a sysinfo update
    self.sysinfoQueued = true;
    self.cnapiQueue.push('sysinfo', function _onSysinfoUpdated() {
        self.sysinfoQueued = false;
        self.sysinfoCount++;
        if (callback !== undefined) {
            callback();
        }
    });
};

/*
 * This is used to serialize updates to CNAPI to ensure that we don't overload a
 * busy CNAPI by sending more than 1 request at a time. This is handled via a
 * vasync queue which calls this function to dispatch updates we need to make to
 * CNAPI. As cn-agent decides it needs to make updates, it pushes to the queue
 * to be executed asap, but not before other outstanding updates are completed.
 */
function sendToCnapi(msgType, callback) {
    var self = this; // we .bind() this to the App

    switch (msgType) {
        case 'agents':
            self.updateAgents(function _onAgentUpdate(err) {
                if (err) {
                    self.log.error({
                        err: err
                    }, 'Error updating agents info into CNAPI');
                }
                callback();
            });
            break;
        case 'heartbeat':
            self.postHeartbeat(callback);
            break;
        case 'status':
            self.postStatus(callback);
            break;
        case 'sysinfo':
            self.registerServer(callback);
            break;
        default:
            assert.fail('', '',
                'Malfunction: unknown cnapi message type: "%s"', msgType);
            break;
    }
}

App.prototype.postHeartbeat = function postHeartbeat(callback) {
    var self = this;

    var hburlpath = '/servers/' + self.uuid + '/events/heartbeat';

    self.cnapiClient.post({ path: hburlpath }, {},
        function _onHeartbeatPosted(err) {

        if (err) {
            self.log.warn({ error: err }, 'Failed to post heartbeat to CNAPI');
        } else {
            self.log.debug('Posted heartbeat to CNAPI');
        }

        callback();
    });
};

App.prototype.postStatus = function postStatus(callback) {
    var self = this;

    assert.object(self.latestStatus, 'self.latestStatus');

    var statusurlpath = '/servers/' + self.uuid + '/events/status';

    self.cnapiClient.post({ path: statusurlpath }, self.latestStatus,
        function _onStatusPosted(err) {

        if (err) {
            self.log.warn({ error: err }, 'Failed to post status to CNAPI');
        } else {
            self.log.debug('Posted status to CNAPI');
        }

        callback();
    });
};

App.prototype.startHeartbeater = function () {
    var self = this;
    var statusReporter;

    assert.object(self.cnapiClient, 'self.cnapiClient');

    statusReporter = new StatusReporter({
        backend: self.backend,
        log: self.log,
        serverUuid: self.uuid
    });

    // When the statusReporter tells us we need to update the status, we record
    // the latest status and queue an update. If a newer status comes in in the
    // meantime, we'll update self.latestStatus, so when we finally run the
    // status update, it will always post the latest one we have at that time.
    statusReporter.on('status', function _queueStatusUpdate(_status) {
        self.log.trace({ status: _status }, 'Status report');
        self.latestStatus = _status;
        self.queueStatusUpdateIfNotAlreadyQueued();
    });

    // Before we actually start the statusReporter, we want to make sure CNAPI
    // has the latest agents. So queue an agent update first and only start()
    // the reporter when the agents update has completed.
    self.cnapiQueue.push('agents', function _agentUpdateComplete() {
        // Queue first heartbeat. After this, heartbeats will requeue
        // HEARTBEAT_INTERVAL after each heartbeat is posted.
        self.queueHeartbeat();

        statusReporter.start();
    });
};


// Whenever we start up, or when sysinfo changes we want to ensure we've updated
// the sysinfo in CNAPI. This ensures we've got the correct 'Boot Time' for
// example. (See also: TRITON-69)
//
// We also pass the cnAgentPort which CNAPI can use to communicate with this
// cn-agent instance.
App.prototype.registerServer = function registerServer(callback) {
    var self = this;

    assert.object(self.cnapiClient, 'self.cnapiClient');

    var serverAddress = self.agentserver.server.address();

    // We always grab the sysinfo here so that we're only ever trying to POST
    // the most recent state. If the POST fails (e.g. with an ETag error) the
    // whole registerServer will be retried, so we'll re-gather the sysinfo
    // which should ensure we're never overwriting newer sysinfo with older
    // sysinfo.
    self.backend.getSysinfo({
        serverAddress: serverAddress,
        serverUuid: self.uuid
    }, function onSysinfo(sysinfoErr, sysinfoObj) {
        assert.ifError(sysinfoErr, 'sysinfo should always succeed');

        var urlPath = path.join('/servers', self.uuid, 'sysinfo');

        // Set the sysinfo we just grabbbed.
        self.sysinfo = sysinfoObj;

        // We'll add our port to the sysinfo here so that if we're not using
        // the default port, CNAPI knows where to send requests to us. Our
        // IP can be found from sysinfo['Admin IP'].
        self.sysinfo['CN Agent Port'] = serverAddress.port;

        // Make an attempt, if that fails, schedule a new attempt with a delay.
        self.cnapiClient.post({
            path: urlPath
        }, {
            sysinfo: self.sysinfo
        }, function _afterPost(err, req, res, obj) {
            var delay;

            if (err) {
                if (err.statusCode === 404 &&
                    err.restCode === 'ResourceNotFound') {

                    // If we get a 404, that means we've got an old CNAPI that
                    // doesn't support registering sysinfo. So we'll not keep
                    // retrying in this case.
                    self.log.warn({
                        err: err
                    }, 'CNAPI does not seem to support sysinfo ' +
                        'registration. Skipping.');

                    callback();
                    return;
                }

                delay = self.registerBackoff.duration();

                self.log.warn({
                    err: err,
                    retryInMs: delay
                }, 'Error posting sysinfo to CNAPI, will retry.');

                setTimeout(function _registerAgain() {
                    // The .call() is necessary here because we want the
                    // registerServer function to have the correct `self`, so
                    // that it has self.log, and the same self.registerBackoff
                    // that we do.
                    registerServer.call(self, callback);
                }, delay);

                // Note: we don't call callback() because we wait until we're
                // successful.

                return;
            }

            callback();

            self.log.info({
                headers: res.headers,
                statusCode: res.statusCode,
                sysinfoCount: self.sysinfoCount
            }, 'Posted sysinfo to CNAPI');
        });
    });
};


App.prototype.start = function () {
    var self = this;

    var agent;
    var agentserver = self.options.agentserver;
    var logname = self.options.logname;
    var tasklogdir = self.options.tasklogdir;
    var taskspath = self.options.taskspath;
    var queueDefns;
    var uuid = self.uuid;

    queueDefns = jsprim.deepCopy(self.backend.queueDefns);
    assert.object(queueDefns, 'queueDefns');

    agent = new TaskAgent({
        agentserver: agentserver,
        backend: self.backend,
        env: self.options.env,
        log: self.log,
        logname: logname,
        tasklogdir: tasklogdir,
        sysinfo: self.sysinfo,
        taskspath: taskspath,
        timeoutSeconds: DEFAULT_TASK_TIMEOUT_SECONDS,
        uuid: uuid
    });

    for (var i = 0; i < queueDefns.length; i++) {
        queueDefns[i].onhttpmsg = createHttpTaskDispatchFn(agent, taskspath);
    }

    function completeStartup() {
        agent.useQueues(queueDefns);
        self.log.info('Starting cn-agent for %s', self.uuid);
        agent.start();
    }

    if (self.isUpdateHelper) {
        // As described above, we don't want to start the heartbeater or clean
        // up locks that are not ours here. So we just start listening for
        // tasks.
        completeStartup();
        return;
    }

    vasync.pipeline({
        funcs: [
            function _createCnapiConnection(_, cb) {
                self.createCnapiConnection(cb);
            }, function _startSysinfoFileWatcher(_, cb) {
                self.backend.watchSysinfo({serverUuid: self.uuid},
                    function _onSysinfoChange() {
                        // This function (_onSysinfoChange) is called once on
                        // startup and then again any time the sysinfo changes.
                        // On the *first* call, we want to call cb() only after
                        // we've updated CNAPI.
                        self.log.info('Saw sysinfo change, updating to CNAPI');
                        self.queueSysinfoUpdateIfNotAlreadyQueued();
                    });
                cb();
            }, function _startHeartbeater(_, cb) {
                self.startHeartbeater();
                cb();
            }, function _cleanupStaleLocks(_, cb) {
                if (self.backend.cleanupStaleLocks === undefined) {
                    cb();
                    return;
                }

                self.backend.cleanupStaleLocks({}, cb);
            }
        ]
    }, function onPipelineComplete(err) {
        if (err) {
            throw err;
        }

        completeStartup();
    });
};


module.exports = App;
