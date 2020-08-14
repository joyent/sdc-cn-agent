/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

var child_process = require('child_process');
var fs = require('fs');

var assert = require('assert-plus');
var forkExecWait = require('forkexec').forkExecWait;
var vasync = require('vasync');

var Task = require('../../../task_agent/task');


// Try to match Ur's default env for backward compat.
var DEFAULT_ENV = {};
var MAX_BUFFER = 5 * 1024 * 1024;


var CommandExecuteTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(CommandExecuteTask);

// Generate a hex representation of a random four byte string.
// (copied from Ur)
function genId() {
    return Math.floor(Math.random() * 0xffffffff).toString(16);
}

// Quick and dirty generation of tmp filenames.
// (copied from Ur)
function tmpFilename() {
    return '/tmp/cnagent-' + genId();
}

// Execute a script string. Tries to work similarly to Ur's executeScript.
function executeScript(opts, script, env, args, callback) {
    var filename = tmpFilename();
    var results = {};

    opts.log.info('Executing script: ' + script);
    opts.log.info('Writing file ' + filename);

    vasync.pipeline({ funcs: [
        function writeFile(_, cb) {
            fs.writeFile(filename, script, cb);
        },
        function makeExecutable(_, cb) {
            fs.chmod(filename, parseInt('0700', 8), cb);
        },
        function executeFile(_, cb) {
            var argv = [filename].concat(args);

            forkExecWait({
                argv: argv,
                env: env,
                maxBuffer: MAX_BUFFER,
                timeout: opts.timeout ? opts.timeout : 0
            }, function onExec(err, info) {
                results = {
                    err: info.error,
                    exitCode: info.status,
                    signal: info.signal,
                    stderr: info.stderr,
                    stdout: info.stdout
                };

                cb();
            });
        }
    ] }, function _executedScript(err) {
        fs.unlink(filename, function onUnlink(unlinkErr) {
            if (unlinkErr) {
                opts.log.info({
                    err: unlinkErr,
                    filename: filename
                }, 'Error unlinking file');
            }
            callback(err, results);
        });
    });
}

function start(callback) {
    var self = this;
    var opts = {};
    var req = self.req;

    assert.object(req, 'req');
    assert.object(req.params, 'req.params');
    assert.optionalArray(req.params.args, 'req.params.args');
    assert.optionalObject(req.params.env, 'req.params.env');
    assert.string(req.params.script, 'req.params.script');
    assert.optionalNumber(req.params.timeout, 'req.params.timeout');

    opts.log = self.log;
    opts.req_id = self.req.req_id;

    executeScript({
        log: opts.log,
        timeout: req.params.timeout
    },
    req.params.script,
    req.params.env || DEFAULT_ENV,
    req.params.args || [],
    function _onExecute(err, results) {
        assert.equal(err, null);

        opts.log.info({results: results}, 'Executed command');
        self.finish(results);
    });
}

CommandExecuteTask.setStart(start);
