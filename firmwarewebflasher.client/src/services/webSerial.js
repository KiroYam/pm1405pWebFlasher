// services/webSerial.js
export class WebSerialPort {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.onData = null;
    }

    async requestPort() {
        if (!("serial" in navigator)) throw new Error("Web Serial API not supported");
        this.port = await navigator.serial.requestPort();
    }

    async open(baudRate = 115200) {
        if (!this.port) throw new Error("No port selected");

        await this.port.open({
            baudRate,
            dataBits: 8,
            parity: "none",
            stopBits: 1,
            bufferSize: 8100,
            flowControl: "none"
        });

        await this.port.setSignals({
            dataTerminalReady: false,
            requestToSend: false
        });

        this.writer = this.port.writable.getWriter();
        this.readLoop();
    }

    async close() {
        try {
            if (this.reader) {
                try { await this.reader.cancel(); } catch { }
                try { this.reader.releaseLock(); } catch { }
                this.reader = null;
            }

            if (this.writer) {
                try { await this.writer.close(); } catch { }
                try { this.writer.releaseLock(); } catch { }
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

    /**
     * Отправка кадра 2054 байт единой транзакцией
     * @param {Uint8Array} buffer - Массив байт длиной 2054
     */
    /*async sendFWPacket(buffer) {
        if (!this.port || !this.port.writable || !this.writer) {
            throw new Error("Port or writer not ready");
        }

        const CHUNK_SIZE = 64;
        const BODY_SIZE = 2048;
        const TAIL_SIZE = 6;

        // 1. Отправляем 32 пакета по 64 байта
        for (let offset = 0; offset < BODY_SIZE; offset += CHUNK_SIZE) {
            const chunk = buffer.subarray(offset, offset + CHUNK_SIZE);

            // Ждем, пока аппаратный USB-контроллер полностью освободит FIFO
            await this.writer.ready;
            await this.writer.write(chunk);

            // Пауза 2 мс гарантирует, что МК успеет забрать байты из CDC RX
            await new Promise(r => setTimeout(r, 10));
        }

        // 2. Отправляем хвост 6 байт
        const tail = buffer.subarray(BODY_SIZE, BODY_SIZE + TAIL_SIZE);
        await this.writer.ready;
        await this.writer.write(tail);
        await new Promise(r => setTimeout(r, 10));
    }*/
    async sendFWPacket(buffer) {
        if (!this.port || !this.port.writable || !this.writer) {
            throw new Error("Port or writer not ready");
        }
        

        await this.writer.write(buffer);
    }

    async readLoop() {
        if (!this.port || !this.port.readable) return;
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