const os = require("node:os");
const { EventEmitter } = require("node:events");

function cpuSnapshot(cpus = os.cpus()) {
  return cpus.reduce(
    (result, cpu) => {
      const times = cpu.times || {};
      const total = Object.values(times).reduce((sum, value) => sum + Number(value || 0), 0);
      result.idle += Number(times.idle || 0);
      result.total += total;
      return result;
    },
    { idle: 0, total: 0 },
  );
}

function cpuPercent(previous, current) {
  if (!previous || !current) return 0;
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100)));
}

function memoryPercent(total = os.totalmem(), free = os.freemem()) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((total - free) / total) * 100)));
}

class SystemMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.foregroundIntervalMs = options.intervalMs || 2000;
    this.backgroundIntervalMs = options.backgroundIntervalMs || 15000;
    this.intervalMs = this.foregroundIntervalMs;
    this.previousCpu = cpuSnapshot();
    this.timer = null;
    this.state = {
      cpu: 0,
      memory: memoryPercent(),
      updatedAt: Date.now(),
    };
  }

  start() {
    this.sample();
    this.schedule();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  schedule() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.sample(), this.intervalMs);
  }

  setPowerSave(enabled) {
    const nextInterval = enabled ? this.backgroundIntervalMs : this.foregroundIntervalMs;
    if (nextInterval === this.intervalMs) return this.intervalMs;
    this.intervalMs = nextInterval;
    if (!enabled) this.sample();
    if (this.timer) this.schedule();
    return this.intervalMs;
  }

  snapshot() {
    return { ...this.state };
  }

  sample() {
    const currentCpu = cpuSnapshot();
    this.state = {
      ...this.state,
      cpu: cpuPercent(this.previousCpu, currentCpu),
      memory: memoryPercent(),
      updatedAt: Date.now(),
    };
    this.previousCpu = currentCpu;
    this.emit("state", this.snapshot());
  }

}

module.exports = {
  SystemMonitor,
  cpuPercent,
  cpuSnapshot,
  memoryPercent,
};
