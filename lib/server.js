/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019, Joyent, Inc.
 */

/*
 * The compute node agent uses the restify http server defined within
 * this file to fulfill incoming requests. One of these servers can
 * potentially front requests for multiple agents.
 *
 */

var restify = require('restify');
var EventEmitter = require('events').EventEmitter;
var os = require('os');
var util = require('util');
var assert = require('assert-plus');

function AgentHttpServer(opts) {
    var self = this;

    assert.string(opts.bindip, 'opts.bindip');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.uuid, 'opts.uuid');

    if (opts.uuid) {
        self.uuid = opts.uuid;
    }
    self.bindip = opts.bindip;
    self.log = opts.log;

    // port can be set to 0 to have the system choose a port
    if (opts.hasOwnProperty('port')) {
        self.port = opts.port;
    }

    this.server = restify.createServer({
        log: opts.log,
        name: 'Compute Node Agent'
    });

    self.init();
}
util.inherits(AgentHttpServer, EventEmitter);


AgentHttpServer.prototype.start = function start(callback) {
    var self = this;
    var port = self.port;

    if (self.port === undefined) {
        port = process.env.PORT ? process.env.PORT : 5309;
    }

    self.server.listen(port, self.bindip, function () {
        self.log.info(
            '%s listening at %s', self.server.name, self.server.url);

        if (callback !== undefined) {
            callback();
        }
    });
};


AgentHttpServer.prototype.init = function () {
    var self = this;

    // When true, stop accepting new tasks:
    self.draining = false;

    self.handleTasks = {};

    self.log.info('cn-agent binding to IP address %s', self.bindip);

    self.server.use(restify.requestLogger());
    self.server.use(restify.acceptParser(self.server.acceptable));
    self.server.use(restify.authorizationParser());
    self.server.use(restify.queryParser());
    self.server.use(restify.bodyParser({mapParams: true}));

    self.server.on('after', function auditReq(req, res, route, err) {
        var method = req.method;
        var reqpath = req.path();
        if (method === 'GET' || method === 'HEAD') {
            if (reqpath === '/ping') {
                return;
            }
        }
        // Successful GET res bodies are uninteresting and *big*.
        var body = method !== 'GET' &&
                   res.statusCode !== 404 &&
                   Math.floor(res.statusCode/100) !== 2;

        restify.auditLogger({
            log: req.log.child({ route: route && route.name }, true),
            body: body
        })(req, res, route, err);
    });

    self.server.use(function addHeaders(req, res, next) {
        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('Date', new Date());
            res.header('Server', self.server.name);
            res.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);
            res.header('x-server-name', os.hostname());
        });
        next();
    });

    self.server.on('uncaughtException', function (req, res, route, err) {
        req.log.error(err);
        res.send(err);
    });

    self.server.post('/tasks', function (req, res, next) {

        var uuid = req.headers['x-server-uuid'];

        if (!uuid) {
            uuid = self.uuid;
        }

        self.log.warn('Desired uuid was %s', uuid);
        assert.string(uuid, 'uuid');

        if (!self.handleTasks.hasOwnProperty(uuid)) {
            self.log.warn('Agent not hooked up for uuid %s', uuid);
            self.log.info({ handleTasks: self.handleTasks }, 'Handle tasks');

            res.send(404);
            next();
            return;
        }

        if (self.draining) {
            next(new restify.ServiceUnavailableError(
                'CN Agent is not accepting tasks for maintenance'));
            return;
        }

        self.handleTasks[uuid](req, res, next);
        return;
    });

    self.server.get('/history', function (req, res, next) {
        var history = self.taskHistory || [];
        res.send(200, history);
        next();
        return;
    });

    // Stop accepting new tasks, probably b/c we're gonna update
    // the agent itself or reboot the server where the agent is
    // running:
    self.server.post('/pause', function (req, res, next) {
        if (!self.draining) {
            self.draining = true;
        }
        res.send(204);
        next();
        return;
    });

    // Accept new tasks again. (After an agent reboot, it will always
    // accept new tasks).
    self.server.post('/resume', function (req, res, next) {
        if (self.draining) {
            self.draining = false;
        }
        res.send(204);
        next();
        return;
    });
};

AgentHttpServer.prototype.registerTaskHandler = function (uuid, handler) {
    var self = this;
    self.log.info('Registering handler for %s', uuid);
    self.handleTasks[uuid] = handler;
};


AgentHttpServer.prototype.setTaskHistory = function (history) {
    var self = this;
    self.taskHistory = history;
};


module.exports = AgentHttpServer;
