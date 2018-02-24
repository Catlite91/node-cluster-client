import * as cluster from 'cluster'
import { CLUSTER_CLIENT, REGISTERD_FUNCTIONS, MESSAGE_TYPES } from './constant'

export default class ClusterClient {
  public static leaderId
  public static followerIds = []
  public static instances = []
  public static ipc = require('node-ipc')
  public static SERVER_NAME = 'leader_server'

  public static initMaster(options: { id: string } = { id: '' }) {
    if (process[CLUSTER_CLIENT]) {
      return
    }
    process[CLUSTER_CLIENT] = true
    ClusterClient.SERVER_NAME = options.id || ClusterClient.SERVER_NAME
    cluster.on('message', (worker, message, handle) => {
      if (message.type === MESSAGE_TYPES.COMPETITION) {
        if (!message.path || !Array.isArray(message.path)) {
          message.path = [worker.id]
        }
        message.path.push('master')
        message.from = worker.id
        // if (message.type === MESSAGE_TYPES.COMPETITION) {
        // for leader competition
        if (!ClusterClient.leaderId) {
          // the first incomming message
          ClusterClient.leaderId = worker.id
        }
        const isLeader = ClusterClient.leaderId === worker.id
        message.data = {
          leaderId: ClusterClient.leaderId,
          serverName: ClusterClient.SERVER_NAME
        }
        if (!isLeader) {
          ClusterClient.followerIds.push(worker.id)
        }
        // }
        cluster.workers[message.to].send(message)
      }
    })
  }

  public static initWorker() {
    return new Promise((resolve, reject) => {
      if (process[CLUSTER_CLIENT]) {
        resolve()
      }
      process[CLUSTER_CLIENT] = true
      const LEADER_COMPETITION_REQUEST_ID = `LEADER-COMPETITION-${process.pid}-${Date.now()}-${Math.random()}`
      // send message to master for leader competition
      process.send({
        id: LEADER_COMPETITION_REQUEST_ID,
        type: MESSAGE_TYPES.COMPETITION,
        to: cluster.worker.id // return back to self
      })
      process.on('message', message => {
        if (message.id === LEADER_COMPETITION_REQUEST_ID) {
          // for leader competition
          ClusterClient.leaderId = message.data.leaderId
          ClusterClient.SERVER_NAME = message.data.serverName
          if (ClusterClient.leaderId === cluster.worker.id) {
            // init ipc server
            ClusterClient.ipc.config.id = ClusterClient.SERVER_NAME
            ClusterClient.ipc.silent = true
            ClusterClient.ipc.config.retry = 1500
            ClusterClient.ipc.serve(
              () => {
                // received request from worker
                ClusterClient.ipc.server.on(
                  MESSAGE_TYPES.SOCKET_REQUEST,
                  async (msg, socket) => {
                    // received request from workers
                    // get the result from the given resolve function
                    const instance = ClusterClient.instances[msg.data.moduleIndex]
                    try {
                      msg.data = await instance[msg.data.method].apply(instance, msg.data.args)
                    } catch (e) {
                      msg.error = {
                        code: e.code,
                        message: e.message,
                        stack: e.stack,
                      }
                    }
                    ClusterClient.ipc.server.emit(
                      socket,
                      MESSAGE_TYPES.SOCKET_RESPONSE,
                      msg
                    )
                  }
                )
              }
            )

            ClusterClient.ipc.server.start()
            resolve()
          } else {
            // init client
            ClusterClient.ipc.config.id = `client-${cluster.worker.id}`
            ClusterClient.ipc.silent = true
            ClusterClient.ipc.config.retry = 1500

            setTimeout(() => {
              ClusterClient.ipc.connectTo(
                ClusterClient.SERVER_NAME,
                () => {
                  ClusterClient.ipc.of[ClusterClient.SERVER_NAME].on(
                    MESSAGE_TYPES.SOCKET_RESPONSE,
                    async msg => {
                      // received data from agent
                      const resolve = process[REGISTERD_FUNCTIONS][msg.id].resolve
                      const reject = process[REGISTERD_FUNCTIONS][msg.id].reject
                      // resolve it
                      if (msg.error) reject.call(reject, msg.error)
                      else resolve.call(resolve, msg.data)
                      // delete the resolve function
                      delete process[REGISTERD_FUNCTIONS][msg.id]
                    }
                  )
                  resolve()
                }
              )
            }, 200)
          }
        }
      })
    })
  }

  private ModuleClass
  private moduleIndex
  private moduleInstance
  constructor(ModuleClass) {
    this.ModuleClass = ModuleClass
    if (!process[REGISTERD_FUNCTIONS]) {
      process[REGISTERD_FUNCTIONS] = {}
    }
  }

  create(...args) {
    const isLeader = ClusterClient.leaderId === cluster.worker.id
    this.moduleIndex = ClusterClient.instances.length
    if (isLeader) {
      this.moduleInstance = new this.ModuleClass(...args)
      ClusterClient.instances[this.moduleIndex] = this.moduleInstance
    } else {
      this.moduleInstance = new Proxy({}, {
        get: (trapTarget, key, receiver) =>
          (...params) =>
            new Promise((resolve, reject) => {
              const requestId = `${this.ModuleClass.name}.${key}-${process.pid}-${Date.now()}-${Math.random()}`
              process[REGISTERD_FUNCTIONS][requestId] = { resolve, reject }
              ClusterClient.ipc.of[ClusterClient.SERVER_NAME].emit(
                MESSAGE_TYPES.SOCKET_REQUEST,
                {
                  id: requestId,
                  data: {
                    moduleIndex: this.moduleIndex,
                    method: key,
                    args: params
                  },
                  to: ClusterClient.leaderId
                })
            })
      })
      ClusterClient.instances[this.moduleIndex] = this.moduleInstance
    }
    return this.moduleInstance
  }
}
