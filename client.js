/**
 * Copyright 2017 Michael Jacobsen.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

/*

SYSTEMD startup file

/etc/systemd/system/sonos-speak.service:

[Unit]
Description=Node.js SONOS Server

[Service]
ExecStart=/usr/bin/node /home/nodered/sonos/server.js
WorkingDirectory=/home/nodered/sonos
Restart=always
SyslogIdentifier=sonos-speak
User=nodered
Group=nodered
Environment=NODE_ENV=production PORT=5005

[Install]
WantedBy=multi-user.target
*/

module.exports = function(RED) {
    "use strict"

    var http        = require("follow-redirects").http
    var https       = require("follow-redirects").https
    var urllib      = require("url")
    var querystring = require("querystring")
    var async       = require("async")

	/******************************************************************************************************************
	 * 
	 *
	 */
    function SonosSayNode(config) {
        RED.nodes.createNode(this, config)

        this.room        = config.room
        this.preClip     = config.preclip
        this.preClipVol  = config.preclipvol
        this.postClip    = config.postclip
        this.postClipVol = config.postclipvol
        this.volume      = config.volume

        this.client      = config.client
        this.clientConn  = RED.nodes.getNode(this.client)

        var node = this

        if (this.clientConn) {
            node.clientConn.register(this)
        } else {
            this.error(RED._("sonos.errors.missing-config"))
        }

        this.on('input', function (msg) {
            var val

            if (typeof msg.payload === 'string') {
                val = msg.payload
            } else if (typeof msg.payload === 'number') {
                val = parseInt(msg.payload)
            } else if (typeof msg.payload === 'boolean') {
                if (msg.payload == false) {
                    val = "true"
                } else {
                    val = "false"
                }
            } else if (typeof msg.payload === 'object') {
                node.error(RED._("sonos.errors.invalid-value-type"))
                return
            } else {
                node.error(RED._("sonos.errors.invalid-value-type"))
                return
            }
            
            if (val == "<ignore>") {
                RED.log.debug("SonosSayNode(input): ignore")
                return
            }

            RED.log.debug("SonosSayNode(input): val = '" + val + "'")

            node.clientConn.say(node.room, 
                                node.preClip, 
                                node.preClipVol, 
                                node.postClip, 
                                node.postClipVol, 
                                val, 
                                node.volume)
        })

        /******************************************************************************************************************
         * notifications coming from Node-RED
         *
         */
        this.on('close', function(removed, done) {
            if (node.clientConn) {
                node.clientConn.deregister(node, done)
            }

            if (removed) {
                // this node has been deleted
            } else {
                // this node is being restarted
            }
        });
    }

    RED.nodes.registerType("sonos say", SonosSayNode)

	/******************************************************************************************************************
	 * 
	 *
	 */
    function SonosHTTPServerNode(config) {
        RED.nodes.createNode(this, config)

        // configuration options passed by Node Red
        this.server     = config.server
        this.port       = config.port
        this.lang       = config.lang
        this.users      = {}
        this.closing    = false

        if (RED.settings.httpRequestTimeout) { 
            this.reqTimeout = parseInt(RED.settings.httpRequestTimeout) || 120000
        } else { 
            this.reqTimeout = 120000
        }

        var prox, noprox

        if (process.env.http_proxy != null) { prox   = process.env.http_proxy }
        if (process.env.HTTP_PROXY != null) { prox   = process.env.HTTP_PROXY }
        if (process.env.no_proxy   != null) { noprox = process.env.no_proxy.split(",") }
        if (process.env.NO_PROXY   != null) { noprox = process.env.NO_PROXY.split(",") }

        var nodeUrl        = "http://" + this.server + ":" + this.port
        var nodeMethod     = "GET"

        var node = this

        this.q = async.queue(function(url, callback) {
            var method  = nodeMethod
            var ctSet   = "Content-Type"       // set default camel case
            var clSet   = "Content-Length"
            var payload = ""

            RED.log.debug("SonosHTTPServerNode(queue): url = " + url)

            var opts     = urllib.parse(url)
            opts.method  = method
            opts.headers = {}

            if (opts.headers['content-length'] == null) {
                if (Buffer.isBuffer(payload)) {
                    opts.headers[clSet] = payload.length
                } else {
                    opts.headers[clSet] = Buffer.byteLength(payload)
                }
            }

            // revert to user supplied Capitalisation if needed.
            if (opts.headers.hasOwnProperty('content-type') && (ctSet !== 'content-type')) {
                opts.headers[ctSet] = opts.headers['content-type']
                delete opts.headers['content-type']
            }

            if (opts.headers.hasOwnProperty('content-length') && (clSet !== 'content-length')) {
                opts.headers[clSet] = opts.headers['content-length']
                delete opts.headers['content-length']
            }        

            var msg       = {}
            var urltotest = url
            var noproxy

            if (noprox) {
                for (var i in noprox) {
                    if (url.indexOf(noprox[i]) !== -1) { noproxy=true }
                }
            }

            if (prox && !noproxy) {
                var match = prox.match(/^(http:\/\/)?(.+)?:([0-9]+)?/i)
                if (match) {
                    opts.headers['Host'] = opts.host
                    var heads            = opts.headers
                    var path             = opts.pathname = opts.href
                    opts                 = urllib.parse(prox)
                    opts.path            = opts.pathname = path
                    opts.headers         = heads
                    opts.method          = method
                    urltotest            = match[0]
                } else { 
                    node.warn("Bad proxy url: " + process.env.http_proxy)
                }
            }

            var req = ((/^https/.test(urltotest))?https:http).request(opts,function(res) {
                res.setEncoding('utf8')
                msg.statusCode  = res.statusCode
                msg.headers     = res.headers
                msg.responseUrl = res.responseUrl
                msg.payload     = ""

                res.on('data', function(chunk) {
                    msg.payload += chunk
                })

                res.on('end', function() {
                    try { 
                        msg.payload = JSON.parse(msg.payload)
                    }
                    catch(e) { 
                        node.warn(RED._("httpin.errors.json-error"))
                    }

                    RED.log.debug("SonosHTTPServerNode(queue): payload = " + msg.payload)

                    //
                    // mark that we're done
                    //
                    callback()
                })
            })

            req.setTimeout(node.reqTimeout, function() {
                node.error(RED._("common.notification.errors.no-response"), msg)
                setTimeout(function() {
                    node.warn("no response")
                    //
                    // mark that we're done
                    //
                    callback()
                }, 10)

                req.abort()
            })

            req.on('error', function(err) {
                node.error(err)

                //
                // mark that we're done
                //
                callback()
            })

            req.end()
        }, 1)

        // define functions called by our nodes
        this.register = function(sonosNode) {
            RED.log.debug("SonosHTTPServerNode(): register")
            node.users[sonosNode.id] = sonosNode

            if (Object.keys(node.users).length === 1) {

            }
        }

        this.deregister = function(sonosNode, done) {
            RED.log.debug("SonosHTTPServerNode(): deregister")
            delete node.users[sonosNode.id]

            if (node.closing) {
                return done()
            }

            if (Object.keys(node.users).length === 0) {
                return done()
            }

            done()
        }

        this.say = function(room, preClip, preClipVol, postClip, postClipVol, text, volume) {
            RED.log.debug("SonosHTTPServerNode(): room        = " + room)
            RED.log.debug("SonosHTTPServerNode(): preClip     = " + preClip)
            RED.log.debug("SonosHTTPServerNode(): preClipVol  = " + preClipVol)
            RED.log.debug("SonosHTTPServerNode(): postClip    = " + postClip)
            RED.log.debug("SonosHTTPServerNode(): postClipVol = " + postClipVol)
            RED.log.debug("SonosHTTPServerNode(): text        = " + text)
            RED.log.debug("SonosHTTPServerNode(): volume      = " + volume)

            if (preClip != "" && preClipVol > 0) {
                if (text != "" && volume > 0) {
                    // /[Room name]/say/[phrase][/[language_code]][/[announce volume]]
                    node.q.push(nodeUrl + "/" + room + "/say/" + text + "/" + node.lang + "/0", function(err) {
                        //console.log('finished processing pre-parse of text')
                    })
                }

                // /{Room name}/clip/{filename}[/{announce volume}]
                node.q.push(nodeUrl + "/" + room + "/clip/" + preClip + "/" + preClipVol, function(err) {
                    //console.log('finished processing preClip')
                })
            }

            if (text != "" && volume > 0) {
                // /[Room name]/say/[phrase][/[language_code]][/[announce volume]]
                node.q.push(nodeUrl + "/" + room + "/say/" + text + "/" + node.lang + "/" + volume, function(err) {
                    //console.log('finished processing text')
                })
            }

            if (postClip != "" && postClipVol > 0) {
                // /{Room name}/clip/{filename}[/{announce volume}]
                node.q.push(nodeUrl + "/" + room + "/clip/" + postClip + "/" + postClipVol, function(err) {
                    //console.log('finished processing postClip')
                })
            }
        }

        /******************************************************************************************************************
         * notifications coming from Node-RED
         *
         */
        this.on('close', function(removed, done) {
            node.closing = true;

            if (removed) {
                // this node has been deleted
            } else {
                // this node is being restarted
            }

            done();
        });
    }

    RED.nodes.registerType("sonos-http-server", SonosHTTPServerNode)
}
