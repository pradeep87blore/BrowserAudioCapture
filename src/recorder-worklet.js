class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.channels = 0
    this.pending = []
    this.pendingFrames = 0
    this.batchFrames = Math.max(128, Math.round(sampleRate * 0.1))
    this.port.onmessage = (event) => {
      if (event.data && event.data.command === 'flush') this.flush(true)
    }
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0 || !input[0]) return true
    const channels = input.length
    const frames = input[0].length
    if (!this.channels) this.channels = channels
    const interleaved = new Float32Array(frames * this.channels)
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < this.channels; c++) {
        const data = input[c]
        interleaved[i * this.channels + c] = data ? data[i] || 0 : 0
      }
    }
    this.pending.push(interleaved)
    this.pendingFrames += frames
    if (this.pendingFrames >= this.batchFrames) this.flush(false)
    return true
  }

  flush(isFinal) {
    const channels = this.channels || 1
    const out = new Float32Array(this.pendingFrames * channels)
    let offset = 0
    for (const chunk of this.pending) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    this.pending = []
    this.pendingFrames = 0
    this.port.postMessage({ channels, samples: out, flush: isFinal }, [out.buffer])
  }
}

registerProcessor('recorder-processor', RecorderProcessor)
