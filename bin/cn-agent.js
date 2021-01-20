/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

var os = require('os');
var path = require('path');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var vasync = require('vasync');
var verror = require('verror');

var AgentHttpServer = require('../lib/server');
var App = require('../lib/app');
var dispatch = require('../lib/task_agent/dispatch');

var createHttpTaskDispatchFn = dispatch.createHttpTaskDispatchFn;
var createTaskDispatchFn = dispatch.createTaskDispatchFn;

var BACKEND_DIR = '../lib/backends';
var LOGNAME = 'cn-agent';


main();

function loadBackend(opts) {
    var Backend;
    var backendName = os.platform();

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    if (process.env.CN_AGENT_BACKEND) {
        // allow overriding the backend (useful for testing)
        backendName = process.env.CN_AGENT_BACKEND;
    } else if (backendName === 'sunos') {
        backendName = 'smartos';
    }

    // Special case for the dummy backend, we allow to specify the server uuid.
    if (backendName === 'dummy' && process.env.CN_AGENT_SERVER_UUID) {
        opts.serverUuid = process.env.CN_AGENT_SERVER_UUID;
    }

    // This will throw if backend doesn't exist
    Backend = require(path.join(BACKEND_DIR, backendName));

    // Backends should set self.name = opts.backendName.
    opts.backendName = backendName;

    return (new Backend(opts));
}

function main() {
    var log;
    var sysinfo;
    var sdc_config;

    var agentConfig;
    var backend;
    var adminIp;

    log = bunyan.createLogger({
        level: process.env.CN_AGENT_LOG_LEVEL,
        name: LOGNAME
    });

    backend = loadBackend({
        log: log
    });

    assert.object(backend, 'backend');
    assert.string(backend.name, 'backend.name');

    log.info('cn-agent starting with backend "' + backend.name + '"');

    vasync.pipeline({
        funcs: [
            function getAgentConfig(_, cb) {
                backend.getAgentConfig({}, function onAgentConfig(err, config) {
                    if (err) {
                        cb(new verror.VError(err, 'fetching agent config'));
                        return;
                    }
                    agentConfig = config;
                    cb();
                });
            }, function ensureNoRabbit(_, cb) {
                if (os.platform() === 'linux') {
                    // Linux doesn't use rabbit at all.
                    cb();
                    return;
                }
                if (agentConfig.no_rabbit) {
                    cb();
                    return;
                }

                log.warn('"no_rabbit" flag is not true, ' +
                    'cn-agent will now sleep');
                /* JSSTYLED */
                // http://nodejs.org/docs/latest/api/all.html#all_settimeout_cb_ms
                // ...The timeout must be in the range of 1-2,147,483,647
                // inclusive...
                setInterval(function () {}, 2000000000);

                // Important: in this case we're *not* calling cb() because we
                // want to hang forever. It's what rabbit holdouts deserve.

            }, function getSysinfo(_, cb) {
                backend.getSysinfo({}, function onSysinfo(err, sysinfoObj) {
                    if (err) {
                        cb(new verror.VError(err, 'fetching sysinfo'));
                        return;
                    }
                    sysinfo = sysinfoObj;
                    cb();
                });
            }, function getSdcConfig(_, cb) {
                backend.getSdcConfig({}, function onSdcConfig(err, config) {
                    if (err) {
                        cb(new verror.VError(err, 'fetching SDC config'));
                        return;
                    }
                    sdc_config = config;
                    cb();
                });
            }, function getAdminIp(_, cb) {
                backend.getFirstAdminIp({}, sysinfo, function (err, ip) {
                    if (err) {
                        cb(new verror.VError(err, 'fetching admin IP'));
                        return;
                    }
                    adminIp = ip;
                    cb();
                });
            }
        ]
    }, function onPipelineComplete(err) {
        var agentServer;
        var app;
        var options;

        if (err) {
            throw err;
        }

        agentServer = new AgentHttpServer({
            bindip: adminIp,
            log: log,
            uuid: sysinfo.UUID
        });
        agentServer.start();

        options = {
            agentserver: agentServer,
            backend: backend,
            config: agentConfig,
            log: log,
            logname: LOGNAME,
            sdc_config: sdc_config,
            sysinfo: sysinfo,
            tasklogdir: agentConfig.tasklogdir ||
                '/var/log/' + LOGNAME + '/logs',
            taskspath: path.join(__dirname, '..',
                'lib/backends', backend.name, 'tasks'),
            uuid: sysinfo.UUID
        };

        app = new App(options);

        // EXPERIMENTAL
        if (agentConfig.fluentd_host) {
            process.env.FLUENTD_HOST = agentConfig.fluentd_host;
        }

        app.start();

    });
}
