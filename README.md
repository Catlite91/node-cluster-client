```javascript
import * as os from 'os'
import * as cluster from 'cluster'
import ClusterClient from 'node-cluster-client'

const forkNum = os.cpus().length <= 3 ? 3 : os.cpus().length
    if (cluster.isMaster) {
      ClusterClient.initMaster()
      for (let i = 0; i < forkNum; i++) {
        cluster.fork()
      }
      ...
    } else {
      ClusterClient.initWorker()
      ...
    }
```

```javascript
import Redis from 'ioredis'

// will return the real instance in the leader process
// and the empty object which proxy to the real instance via node-ipc
const myClusterRedis = new ClusterClient(Redis).create(option)
```