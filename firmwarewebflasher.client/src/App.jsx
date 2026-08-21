import React, { useRef, useState } from "react";
import "./App.css";
import { WebSerialPort } from "./services/webSerial";
import { parseIntelHex } from "./utils/parseIntelHex";
import { computeCRC8, computeCRC16 } from "./utils/crc8";

export default function App() {
    const serial = useRef(new WebSerialPort());
    const firmware = useRef({ bytes: [], blocks: 0 });
    const indexRef = useRef(0);
    const packetBufRef = useRef([]);

    const [log, setLog] = useState("");
    const [progress, setProgress] = useState("");
    const [devAddr, setDevAddr] = useState("01");
    const [portState, setPortState] = useState("closed");
    const [fileName, setFileName] = useState("");

    const statusFileHandleRef = useRef(null);
    const statusFileContentRef = useRef(null);
    const [statusFileName, setStatusFileName] = useState("");

    function appendLog(s) {
        setLog((p) => p + s + "\n");
        console.log(s);
    }

    async function selectAndOpenPort() {
        try {
            await serial.current.requestPort();
            await serial.current.open(115200);
            serial.current.onData = handleIncoming;
            setPortState("opened");
            appendLog("Port opened");
        } catch (e) {
            appendLog("Port open error: " + e);
        }
    }

    async function closePort() {
        try {
            await serial.current.close();
            setPortState("closed");
            appendLog("Port closed");
        } catch (e) {
            appendLog("Close error: " + e);
        }
    }

    async function handleFile(e) {
        const f = e.target.files?.[0];
        if (!f) return;
        setFileName(f.name);
        const text = await f.text();
        try {
            const { bytes, blocks } = parseIntelHex(text);
            firmware.current.bytes = bytes;
            firmware.current.blocks = blocks;
            appendLog(`Parsed ${bytes.length} bytes, ${blocks} blocks`);
        } catch (err) {
            appendLog("HEX parse error: " + err);
        }
    }

    function buildFWPacket(index) {
        const size = firmware.current.bytes.length;
        const indexEnd = firmware.current.blocks || Math.ceil(size / 2048);
        const buflen = 2054; // 2052 data + 2 CRC
        const bufwr = new Uint8Array(buflen);

        bufwr[0] = 0xAA;
        bufwr[1] = 0x02; // type - firmware
        bufwr[2] = index & 0xFF;
        bufwr[3] = (indexEnd - 1) & 0xFF;

        const baseOffset = index * 2048;
        for (let k = 0; k < 2048; k++) {
            const srcPos = k + baseOffset;
            bufwr[k + 4] = (srcPos < size) ? (firmware.current.bytes[srcPos] & 0xFF) : 0x00;
        }

        const crcRez = computeCRC16(bufwr.subarray(0, 2052), 0);
        bufwr[2052] = (crcRez >> 8) & 0xFF;
        bufwr[2053] = crcRez & 0xFF;

        return bufwr;
    }

    async function startFlash() {
        if (!serial.current.port || serial.current.port.readable === null) {
            appendLog("Open a port first");
            return;
        }
        if (!firmware.current.bytes.length) {
            appendLog("Load firmware first");
            return;
        }
        indexRef.current = 0;
        packetBufRef.current = [];
        setProgress("Start: send boot command");
        await sendNextBlock();
        appendLog("Boot command sent. Waiting device response...");
    }

    const isSendingRef = useRef(false);

    // App.jsx
    async function sendNextBlock(delayMs = 0) {
        if (isSendingRef.current) return;
        isSendingRef.current = true;

        // Минимальная пауза 60 мс гарантирует, что МК успел записать Flash
        // и полностью готов слушать следующий каскад USB-прерываний.
        const waitTime = Math.max(delayMs, 60);
        await new Promise(r => setTimeout(r, waitTime));

        const idx = indexRef.current;
        if (idx >= firmware.current.blocks) {
            setProgress("All blocks sent successfully!");
            appendLog("All blocks sent successfully!");
            isSendingRef.current = false;
            return;
        }

        setProgress(`Sending block ${idx} / ${firmware.current.blocks - 1}`);
        const p = buildFWPacket(idx);

        try {
            packetBufRef.current = []; // Очищаем локальный приемник ответов
            await serial.current.sendFWPacket(p);
        } catch (e) {
            appendLog("Send FW packet error: " + e);
        } finally {
            isSendingRef.current = false;
        }
    }

    async function handleIncoming(chunk) {
        const bytes = Array.from(chunk);
        packetBufRef.current.push(...bytes);

        while (packetBufRef.current.length >= 3) {
            if (packetBufRef.current[0] !== 0x55) {
                packetBufRef.current.shift();
                continue;
            }

            const payloadLen = packetBufRef.current[2];
            const totalPacketLen = 3 + payloadLen + 1;

            if (packetBufRef.current.length < totalPacketLen) {
                break;
            }

            const packet = packetBufRef.current.splice(0, totalPacketLen);
            const code = packet[1];
            const len = packet[2];

            if (len === 1) {
                const idx = packet[3];

                if (code === 0x01 && idx === indexRef.current) {
                    indexRef.current++;
                    appendLog(`Block ${idx} ACK -> next index ${indexRef.current}`);
                    // Пауза перед отправкой следующего блока (передаст 60мс в sendNextBlock)
                    await sendNextBlock(60);
                }
                else if (code === 0x00 && idx === 0xFF) {
                    appendLog(`Block ${indexRef.current} NACK -> Flash busy. Waiting 350ms...`);
                    // При NACK даем МК время окончить запись и восстановить CDC RX
                    await sendNextBlock(350);
                }
            } else {
                appendLog(`Ignored long packet/echo (len=${len})`);
            }
        }
    }

    async function findStatusBin() {
        if (!window.showDirectoryPicker) {
            appendLog("File System Access API not available in this environment");
            return;
        }
        try {
            const dirHandle = await window.showDirectoryPicker();
            try {
                const fileHandle = await dirHandle.getFileHandle("STATUS.BIN");
                statusFileHandleRef.current = fileHandle;
                const file = await fileHandle.getFile();
                const buf = new Uint8Array(await file.arrayBuffer());
                statusFileContentRef.current = buf;
                setStatusFileName(`${dirHandle.name}/STATUS.BIN`);
                appendLog(`STATUS.BIN found: ${buf.length} bytes in ${dirHandle.name}`);
            } catch (err) {
                appendLog("STATUS.BIN not found in selected directory");
            }
        } catch (e) {
            appendLog("Directory picker canceled or failed: " + e);
        }
    }

    async function writeUpdFw() {
        if (!statusFileHandleRef.current) {
            appendLog("No STATUS.BIN selected");
            return;
        }
        try {
            const file = await statusFileHandleRef.current.getFile();
            const original = new Uint8Array(await file.arrayBuffer());
            appendLog(`Original STATUS.BIN size: ${original.length}`);

            const encoder = new TextEncoder();
            const cmd = "UPDFW#\r\n";
            const cmdBytes = encoder.encode(cmd);
            const pos = cmdBytes.length;
            const TARGET = 2048;

            const out = new Uint8Array(TARGET);
            out.set(cmdBytes.subarray(0, Math.min(cmdBytes.length, TARGET)), 0);
            for (let i = pos; i < TARGET; i++) {
                out[i] = i < original.length ? original[i] : 0x00;
            }

            try {
                const writable = await statusFileHandleRef.current.createWritable();
                await writable.write(out);
                if (typeof writable.truncate === "function") {
                    await writable.truncate(TARGET);
                }
                await writable.close();
                appendLog("Wrote UPDFW# to STATUS.BIN (2048 bytes) successfully");
                return;
            } catch (err) {
                appendLog("Primary write failed: " + err);
                if (!(err && err.name === "QuotaExceededError")) throw err;
            }

            if (typeof window.showSaveFilePicker === "function") {
                try {
                    const saveHandle = await window.showSaveFilePicker({
                        suggestedName: "STATUS.BIN",
                        types: [{ description: "Binary", accept: { "application/octet-stream": [".bin"] } }]
                    });
                    const w2 = await saveHandle.createWritable();
                    await w2.write(out);
                    await w2.close();
                    appendLog("Saved STATUS.BIN via Save-As (2048 bytes)");
                    statusFileHandleRef.current = saveHandle;
                    setStatusFileName("Saved via Save-As");
                    return;
                } catch (saveErr) {
                    appendLog("Save-As failed: " + saveErr);
                    return;
                }
            } else {
                appendLog("Save-As not available (no showSaveFilePicker).");
            }
        } catch (e) {
            appendLog("Write error: " + e);
        }
    }

    return (
        <div style={{ padding: 20, fontFamily: "Segoe UI, Arial" }}>
            <h2>Firmware Web Flasher</h2>
            <div style={{ marginBottom: 8 }}>
                <button onClick={selectAndOpenPort}>Select & Open Port</button>{" "}
                <button onClick={closePort}>Close Port</button>
                <span style={{ marginLeft: 12 }}>Port: {portState}</span>
            </div>

            <div style={{ marginBottom: 8 }}>
                <label>DevAddr (hex): </label>
                <input value={devAddr} onChange={e => setDevAddr(e.target.value)} style={{ width: 60 }} />
            </div>

            <div style={{ marginBottom: 8 }}>
                <input type="file" accept=".hex,.ihx" onChange={handleFile} />
                <span style={{ marginLeft: 8 }}>{fileName}</span>
            </div>

            <div style={{ marginBottom: 8 }}>
                <button onClick={startFlash}>Flash</button>
                <span style={{ marginLeft: 12 }}>{progress}</span>
            </div>

            <div style={{ marginBottom: 8 }}>
                <button onClick={findStatusBin}>Find STATUS.BIN</button>{" "}
                <button onClick={writeUpdFw}>Write UPDFW#</button>
                <span style={{ marginLeft: 12 }}>{statusFileName}</span>
            </div>

            <div style={{ marginTop: 12 }}>
                <textarea readOnly value={log} rows={12} cols={80} />
            </div>
        </div>
    );
}