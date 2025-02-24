var async = require('async'),
    db = require('../db'),
    createStream = require('kinesalite/actions/createStream'),
    deleteStream = require('kinesalite/actions/deleteStream')

module.exports = function updateTable(store, data, cb) {

  var key = data.TableName, tableDb = store.tableDb

  async.auto({
    lock: function(callback) {
      tableDb.lock(key, function(release) {
        callback(null, release)
      })
    },
    table: ['lock', function(results, callback) {
      store.getTable(key, false, function(err, table) {
        if (err) return callback(err)

        if (table.TableStatus == 'CREATING') {
          err = new Error
          err.statusCode = 400
          err.body = {
            __type: 'com.amazonaws.dynamodb.v20120810#ResourceInUseException',
            message: 'Attempt to change a resource which is still in use: Table is being created: ' + key,
          }
          return callback(err)
        }

        callback(null, table)
      })
    }],
    streamUpdates: ['table', function(results, callback) {
      var table = results.table

      if (!data.StreamSpecification) {
        return callback()
      }

      if (table.LatestStreamLabel && data.StreamSpecification.StreamEnabled === false) {
        return deleteStream(store.kinesalite, { StreamName: data.TableName }, function(err) {
          if (err) return callback(err)

          callback(null, {
            StreamSpecification: {},
            LatestStreamLabel: null,
            LatestStreamArn: null,
          })
        })
      }

      if (!table.LatestStreamLabel && data.StreamSpecification.StreamEnabled === true) {
        return createStream(store.kinesalite, { StreamName: data.TableName, ShardCount: 1 }, function(err) {
          if (err) return callback(err)

          var latestStreamLabel = (new Date()).toISOString().replace('Z', '')
          callback(null, {
            StreamSpecification: data.StreamSpecification,
            LatestStreamLabel: latestStreamLabel,
            LatestStreamArn: 'arn:aws:dynamodb:' + tableDb.awsRegion + ':' + tableDb.awsAccountId + ':table/' + data.TableName + '/stream/' + latestStreamLabel,
          })
        })
      }

      // cf. https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_UpdateTable.html
      // "You will receive a ResourceInUseException if you attempt to enable a
      // stream on a table that already has a stream, or if you attempt to disable
      // a stream on a table which does not have a stream."
      var err = new Error
      err.statusCode = 400
      err.body = {
        __type: 'com.amazonaws.dynamodb.v20120810#ResourceInUseException',
        message: '',
      }
      callback(err)
    }],
    tableUpdates: ['table', function(results, callback) {
      var table = results.table,
          updates, i, update, dataThroughput, tableThroughput, readDiff, writeDiff

      var tableBillingMode = (table.BillingModeSummary || {}).BillingMode || 'PROVISIONED'

      if (data.ProvisionedThroughput && (data.BillingMode || tableBillingMode) == 'PAY_PER_REQUEST') {
        return callback(db.validationError('One or more parameter values were invalid: ' +
          'Neither ReadCapacityUnits nor WriteCapacityUnits can be specified when BillingMode is PAY_PER_REQUEST'))
      }

      try {
        updates = getThroughputUpdates(data, table)
      } catch (err) {
        return callback(err)
      }

      for (i = 0; i < updates.length; i++) {
        update = updates[i]
        dataThroughput = update.dataThroughput
        tableThroughput = update.tableThroughput
        readDiff = dataThroughput.ReadCapacityUnits - tableThroughput.ReadCapacityUnits
        writeDiff = dataThroughput.WriteCapacityUnits - tableThroughput.WriteCapacityUnits

        if (!readDiff && !writeDiff)
          return callback(db.validationError(
            'The provisioned throughput for the table will not change. The requested value equals the current value. ' +
            'Current ReadCapacityUnits provisioned for the table: ' + tableThroughput.ReadCapacityUnits +
            '. Requested ReadCapacityUnits: ' + dataThroughput.ReadCapacityUnits + '. ' +
            'Current WriteCapacityUnits provisioned for the table: ' + tableThroughput.WriteCapacityUnits +
            '. Requested WriteCapacityUnits: ' + dataThroughput.WriteCapacityUnits + '. ' +
            'Refer to the Amazon DynamoDB Developer Guide for current limits and how to request higher limits.'))

        update.setStatus('UPDATING')

        if (readDiff > 0 || writeDiff > 0) tableThroughput.LastIncreaseDateTime = Date.now() / 1000
        if (readDiff < 0 || writeDiff < 0) tableThroughput.LastDecreaseDateTime = Date.now() / 1000

        update.readDiff = readDiff
        update.writeDiff = writeDiff

        if (data.BillingMode == 'PROVISIONED' && tableBillingMode != 'PROVISIONED') {
          tableThroughput.ReadCapacityUnits = dataThroughput.ReadCapacityUnits
          tableThroughput.WriteCapacityUnits = dataThroughput.WriteCapacityUnits
        }
      }

      if (data.BillingMode == 'PAY_PER_REQUEST' && tableBillingMode != 'PAY_PER_REQUEST') {
        table.TableStatus = 'UPDATING'
        table.BillingModeSummary = table.BillingModeSummary || {}
        table.BillingModeSummary.BillingMode = 'PAY_PER_REQUEST'
        table.TableThroughputModeSummary = table.TableThroughputModeSummary || {}
        table.TableThroughputModeSummary.TableThroughputMode = 'PAY_PER_REQUEST'
        table.ProvisionedThroughput = table.ProvisionedThroughput || {}
        table.ProvisionedThroughput.LastDecreaseDateTime = Date.now() / 1000
        table.ProvisionedThroughput.NumberOfDecreasesToday = table.ProvisionedThroughput.NumberOfDecreasesToday || 0
        table.ProvisionedThroughput.ReadCapacityUnits = 0
        table.ProvisionedThroughput.WriteCapacityUnits = 0
        if (table.GlobalSecondaryIndexes) {
          table.GlobalSecondaryIndexes.forEach(function(index) {
            index.IndexStatus = 'UPDATING'
            index.ProvisionedThroughput = index.ProvisionedThroughput || {}
            index.ProvisionedThroughput.NumberOfDecreasesToday = index.ProvisionedThroughput.NumberOfDecreasesToday || 0
            index.ProvisionedThroughput.ReadCapacityUnits = 0
            index.ProvisionedThroughput.WriteCapacityUnits = 0
          })
        }
      } else if (data.BillingMode == 'PROVISIONED' && tableBillingMode != 'PROVISIONED') {
        table.BillingModeSummary = table.BillingModeSummary || {}
        table.BillingModeSummary.BillingMode = 'PROVISIONED'
        table.TableThroughputModeSummary = table.TableThroughputModeSummary || {}
        table.TableThroughputModeSummary.TableThroughputMode = 'PROVISIONED'
      }

      callback(null, updates)
    }],
    updateTable: ['tableUpdates', 'streamUpdates', function(results, callback) {
      var table = results.table

      if (results.streamUpdates) {
        table.StreamSpecification = results.streamUpdates.StreamSpecification
        table.LatestStreamLabel = results.streamUpdates.LatestStreamLabel
        table.LatestStreamArn = results.streamUpdates.LatestStreamArn
      }

      tableDb.put(key, table, callback)
    }],
    setActive: ['updateTable', function(results, callback) {
      var table = results.table, updates = results.tableUpdates

      setTimeout(function() {

        // Shouldn't need to lock/fetch as nothing should have changed
        updates.forEach(function(update) {
          dataThroughput = update.dataThroughput
          tableThroughput = update.tableThroughput

          update.setStatus('ACTIVE')

          if (update.readDiff > 0 || update.writeDiff > 0) {
            tableThroughput.LastIncreaseDateTime = Date.now() / 1000
          } else if (update.readDiff < 0 || update.writeDiff < 0) {
            tableThroughput.LastDecreaseDateTime = Date.now() / 1000
            tableThroughput.NumberOfDecreasesToday++
          }

          if (data.BillingMode == 'PAY_PER_REQUEST' && tableBillingMode != 'PAY_PER_REQUEST') {
            table.TableStatus = 'ACTIVE'
            table.BillingModeSummary.LastUpdateToPayPerRequestDateTime = Date.now() / 1000
            table.TableThroughputModeSummary.LastUpdateToPayPerRequestDateTime = Date.now() / 1000
            delete table.ProvisionedThroughput.LastDecreaseDateTime
            if (table.GlobalSecondaryIndexes) {
              table.GlobalSecondaryIndexes.forEach(function(index) {
                index.IndexStatus = 'ACTIVE'
                index.ProvisionedThroughput.NumberOfDecreasesToday++
                index.ProvisionedThroughput.LastDecreaseDateTime = Date.now() / 1000
              })
            }
          }

          tableThroughput.ReadCapacityUnits = dataThroughput.ReadCapacityUnits
          tableThroughput.WriteCapacityUnits = dataThroughput.WriteCapacityUnits
        })

        tableDb.put(key, table, function(err) {
          // eslint-disable-next-line no-console
          if (err && !/Database is not open/.test(err)) console.error(err.stack || err)
        })

      }, store.options.updateTableMs)

      callback()
    }],
  }, function(err, results) {
    var release = results.lock
    cb = release(cb)

    if (err) {
      return cb(err)
    }

    cb(null, {TableDescription: results.table})
  })
}

function getThroughputUpdates(data, table) {
  var tableBillingMode = (table.BillingModeSummary || {}).BillingMode || 'PROVISIONED'
  var remainingIndexes = (table.GlobalSecondaryIndexes || []).reduce(function(map, index) {
    map[index.IndexName] = true
    return map
  }, Object.create(null))
  var updates = []
  if (data.ProvisionedThroughput) {
    updates.push({
      dataThroughput: data.ProvisionedThroughput,
      tableThroughput: table.ProvisionedThroughput,
      setStatus: function(status) { table.TableStatus = status },
    })
  }
  var globalUpdates = data.GlobalSecondaryIndexUpdates || []
  if (globalUpdates.length > 5) throw db.limitError('Subscriber limit exceeded: Only 1 online index can be created or deleted simultaneously per table')
  globalUpdates.forEach(function(update) {
    var dataThroughput = update.Update && update.Update.ProvisionedThroughput
    if (!dataThroughput) {
      return
    }
    if (dataThroughput.ReadCapacityUnits > 1000000000000 || dataThroughput.WriteCapacityUnits > 1000000000000) {
      throw db.validationError('This operation cannot be performed with given input values. Please contact DynamoDB service team for more info: Action Blocked: IndexUpdate')
    }
    (table.GlobalSecondaryIndexes || []).forEach(function(index) {
      if (index.IndexName == update.Update.IndexName) {
        delete remainingIndexes[index.IndexName]
        updates.push({
          dataThroughput: dataThroughput,
          tableThroughput: index.ProvisionedThroughput,
          setStatus: function(status) { index.IndexStatus = status },
        })
      }
    })
  })
  if (data.BillingMode == 'PROVISIONED' && tableBillingMode != 'PROVISIONED' && Object.keys(remainingIndexes).length) {
    throw db.validationError('One or more parameter values were invalid: ' +
      'ProvisionedThroughput must be specified for index: ' + Object.keys(remainingIndexes).join(','))
  }
  return updates
}
