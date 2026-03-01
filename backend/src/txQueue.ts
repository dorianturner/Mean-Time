// Serialises all on-chain write transactions through a single queue so they
// each get a unique, sequential nonce. Without this, concurrent writeContract
// calls from the same account read the same pending nonce and the second one
// fails with "replacement transaction underpriced".

type Task<T> = {
  fn: () => Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

const queue: Task<any>[] = []
let running = false

async function drain(): Promise<void> {
  if (running) return
  running = true
  while (queue.length > 0) {
    const task = queue.shift()!
    try {
      const result = await task.fn()
      task.resolve(result)
    } catch (err) {
      task.reject(err)
    }
  }
  running = false
}

/**
 * Enqueue a function that performs an on-chain write.
 * Returns a promise that resolves/rejects with the function's result.
 * Guarantees only one write is in-flight at a time.
 */
export function enqueueTx<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({ fn, resolve, reject })
    drain()
  })
}
