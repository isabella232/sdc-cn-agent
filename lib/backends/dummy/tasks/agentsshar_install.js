/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

/*
 *
 */

var path = require('path');

var assert = require('assert-plus');
var vasync = require('vasync');

var backendCommon = require('../../common');
var shared = require('./shared');
var smartdc_config = require('../smartdc-config');
var Task = require('../../../task_agent/task');


function AgentsSharInstallTask(req) {
    Task.call(this);
    this.req = req;
}

Task.createTask(AgentsSharInstallTask);


function start() {
    var self = this;

    assert.object(self.log, 'self.log');
    assert.object(self.req, 'self.req');
    assert.string(self.req.req_id, 'self.req.req_id');
    assert.object(self.req.params, 'self.req.params');
    assert.string(self.req.params.url, 'self.req.params.url');
    assert.object(self.sysinfo, 'self.sysinfo');
    assert.uuid(self.sysinfo.UUID, 'self.sysinfo.UUID');

    self.log.debug({
        server_uuid: self.sysinfo.UUID,
        url: self.req.params.url
    }, 'attempting to install agentshar');

    vasync.pipeline({arg: {}, funcs: [
        function _downloadShar(ctx, cb) {
            ctx.sharFile = path.join('/var/tmp/',
                'agentsshar.download.' + self.sysinfo.UUID +
                path.basename(self.req.params.url));

            backendCommon.downloadFile(
                self.req.params.url,
                ctx.sharFile,
                { log: self.log },
                function _onDownloaded(err) {
                    self.progress(50);
                    cb(err);
                });
        }, function _installShar(ctx, cb) {
            shared.installAgentsShar({
                log: self.log,
                serverUuid: self.sysinfo.UUID,
                sharFile: ctx.sharFile
            }, function _onInstallAgentsShar(err) {
                self.progress(75);

                if (err) {
                    self.log.error({
                        agentsShar: ctx.agentsShar,
                        err: err,
                        sharFile: ctx.sharFile,
                        serverUuid: self.sysinfo.UUID
                    }, 'failed to install agentsshar');
                }

                cb(err);
            });
        }, function _deleteTmpShar(ctx, cb) {
            self.log.info('would delete ' + ctx.sharFile);
            cb();
        }
    ]}, function _onInstallPipelineComplete(err) {
        self.progress(100);

        if (err) {
            self.fatal('Failed to install agentsshar: ' + err.message);
            return;
        }

        self.finish();
    });
}

AgentsSharInstallTask.setStart(start);

module.exports = AgentsSharInstallTask;