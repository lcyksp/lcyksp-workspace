/**
 * The process shares one sqlite3 connection, so any statement issued while another caller holds an
 * open transaction becomes part of that transaction. Site monitor writers therefore queue their
 * statement groups here instead of running them from arbitrary async contexts.
 *
 * Whatever a caller puts inside the queue blocks every other writer, so long network waits belong
 * outside it unless the caller needs the whole operation serialized. A monitor run does, because its
 * fetch result feeds the transaction that follows; mail delivery does not, so it keeps the SMTP
 * session outside the queue and only serializes its short statement groups.
 */
let queueTail = Promise.resolve()

export function enqueueSiteMonitorDbWork(callback) {
  // A rejected predecessor must still hand the queue to the next task.
  const execution = queueTail.then(callback, callback)
  queueTail = execution.catch(() => {})
  return execution
}
