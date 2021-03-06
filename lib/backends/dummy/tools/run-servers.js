/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var fs = require('fs');
var path = require('path');
var util = require('util');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var netconfig = require('triton-netconfig');
var vasync = require('vasync');
var verror = require('verror');

var AgentHttpServer = require('../../../server');
var App = require('../../../app');
var common = require('../common');

function createLog(ctx, callback) {
    var logname = 'cn-agent';

    ctx.log = bunyan.createLogger({
        level: 'info',
        name: logname
    });

    callback();
}

function loadSysinfo(ctx, callback) {
    assert.object(ctx, 'ctx');
    assert.object(ctx.agentserver, 'ctx.agentserver');
    assert.object(ctx.agentserver.server, 'ctx.agentserver.server');
    assert.func(ctx.agentserver.server.address,
        'ctx.agentserver.server.address');
    assert.func(callback, 'callback');

    ctx.backend.getSysinfo({
        serverAddress: ctx.agentserver.server.address(),
        serverUuid: ctx.uuid
    }, function _onSysinfo(err, sysinfo) {
        ctx.sysinfo = sysinfo;
        callback(err);
    });
}

function findZoneAdminIp(ctx, callback) {
    common.mdataGet('sdc:nics', function _onMdata(err, nicsData) {
        var nics;

        try {
            nics = JSON.parse(nicsData.toString());
        } catch (e) {
            callback(e);
            return;
        }

        if (!err) {
            ctx.bindIP = netconfig.adminIpFromNicsArray(nics);
            assert.string(ctx.bindIP, 'ctx.bindIP');
        }

        callback(err);
    });
}

function createAgentServer(ctx, callback) {
    ctx.agentserver = new AgentHttpServer({
        bindip: ctx.bindIP,
        log: ctx.log,
        port: 0,
        uuid: ctx.uuid
    });

    ctx.agentserver.start(function _onStart() {
        callback();
    });
}

function setupBackend(ctx, callback) {
    var Backend;
    var baseDir = path.resolve(__dirname, '../../../..');
    var opts = {};

    assert.object(ctx.log, 'ctx.log');

    Backend = require(path.join(baseDir, 'lib/backends/dummy'));

    opts.log = ctx.log;
    opts.backendName = 'dummy';

    ctx.backend = new Backend(opts);
    ctx.taskspath = path.join(baseDir, 'lib/backends/dummy/tasks');

    ctx.backend.getAgentConfig({}, function onAgentConfig(err, config) {
        if (err) {
            callback(new verror.VError(err, 'fetching agent config'));
            return;
        }
        ctx.config = config;

        ctx.backend.getSdcConfig({}, function onSdcConfig(sdcErr, sdcConfig) {
            if (sdcErr) {
                callback(new verror.VError(sdcErr, 'fetching SDC config'));
                return;
            }
            ctx.sdc_config = sdcConfig;
            callback();
        });
    });
}

function setTaskParams(ctx, callback) {
    ctx.tasklogdir = path.join(common.SERVER_ROOT, ctx.uuid, 'logs/cn-agent');

    callback();
}

function runServer(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.backend, 'opts.backend');
    assert.object(opts.log, 'opts.log');
    assert.uuid(opts.serverUuid, 'opts.serverUuid');

    var ctx = {};
    var inst = opts.serverUuid.split('-')[0];

    ctx.backend = opts.backend;
    ctx.bindIP = opts.bindIP;
    ctx.config = opts.config;
    ctx.log = opts.log.child({instance: inst});
    ctx.logname = 'cn-agent-' + inst;
    ctx.sdc_config = opts.sdc_config;
    ctx.taskspath = opts.taskspath;
    ctx.uuid = opts.serverUuid;

    vasync.pipeline({
        arg: ctx,
        funcs: [
            setTaskParams,
            createAgentServer,
            loadSysinfo
        ]
    }, function pipelineComplete(err) {
        var app;

        if (err) {
            console.error('failed to start CN: %s', err.message);
            callback(err);
            return;
        }

        app = new App(ctx);
        app.start();
        callback();
    });
}

function main() {
    fs.readdir(common.SERVER_ROOT, function _onReadDir(err, dirs) {
        var state = {};

        if (err) {
            console.error('FATAL: %s', err.message);
            process.exit(2);
            return;
        }

        vasync.pipeline({
           arg: state,
           funcs: [
               createLog,
               setupBackend,
               findZoneAdminIp
           ]
        }, function pipelineComplete(pipelineErr) {
            assert.ifError(pipelineErr);

            vasync.forEachPipeline({
                func: function _runServer(serverUuid, cb) {
                    assert.uuid(serverUuid, 'serverUuid');

                    runServer({
                        backend: state.backend,
                        bindIP: state.bindIP,
                        config: state.config,
                        log: state.log,
                        sdc_config: state.sdc_config,
                        serverUuid: serverUuid,
                        taskspath: state.taskspath
                    }, cb);
                },
                inputs: dirs
            }, function _pipelineComplete(_pipelineErr, results) {
                assert.ifError(_pipelineErr);

                state.log.info('Started all servers');
            });
        });
    });
}

main();
