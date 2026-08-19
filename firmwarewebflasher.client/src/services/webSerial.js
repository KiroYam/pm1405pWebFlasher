export class WebSerialPort {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.onData = null; // callback Uint8Array -> void
    }

    async requestPort() {
        if (!("serial" in navigator)) throw new Error("Web Serial API not supported");
        this.port = await navigator.serial.requestPort();
    }

    async open(baudRate = 115200) {
        if (!this.port) throw new Error("No port selected");
        await this.port.open({
            baudRate,
            bufferSize: 25536,
            flowControl: "none" // Явно отключаем аппаратный/программный Flow Control
        });
        this.writer = this.port.writable.getWriter();
        this.readLoop();
    }

    async close() {
        try {
            if (this.reader) {
                await this.reader.cancel();
                this.reader.releaseLock();
                this.reader = null;
            }
            if (this.writer) {
                this.writer.releaseLock();
                this.writer = null;
            }
            if (this.port) {
                await this.port.close();
                this.port = null;
            }
        } catch (e) {
            console.warn("Error closing port", e);
        }
    }

    async writeBytes(bytes) {
        if (!this.writer) throw new Error("Port not open");
        await this.writer.write(new Uint8Array(bytes));
    }

    async readLoop() {
        this.reader = this.port.readable.getReader();
        try {
            while (true) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value && this.onData) this.onData(value);
            }
        } catch (e) {
            console.warn("Read loop stopped", e);
        } finally {
            try { this.reader.releaseLock(); } catch { }
        }
    }
}