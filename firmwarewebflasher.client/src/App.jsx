import React, { useRef, useState } from "react";
import "./App.css";
import { WebSerialPort } from "./services/webSerial";
import { parseIntelHex } from "./utils/parseIntelHex";
import { computeCRC8, computeCRC16 } from "./utils/crc8";

export default function App() {
    const serial = useRef(new WebSerialPort());
    const firmware = useRef({ bytes: [], blocks: 0 });
    const indexRef = useRef(0);
    const [log, setLog] = useState("");
    const [progress, setProgress] = useState("");
    const [devAddr, setDevAddr] = useState("01");
    const [portState, setPortState] = useState("closed");
    const [fileName, setFileName] = useState("");

    // New refs/state for STATUS.BIN handling
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

    async function sendBytes(arr) {
        try {
            await serial.current.writeBytes(arr);
            appendLog("Sent: " + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join(" "));
        } catch (e) {
            appendLog("Send error: " + e);
        }
    }

    // Modified buildFWPacket to follow provided C++ layout (0xAA, type 0x02, index, indexEnd-1, 2048 payload, CRC16)
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

        // compute CRC16 over first 2052 bytes
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
        setProgress("Start: sender loop");
        startSenderLoop();
        appendLog("Sender loop started. Waiting device responses...");
    }

    // New signalling refs for sender loop
    const permissionResolveRef = useRef(null); // function to resolve waiting promise
    const lastAckRef = useRef(null); // { ok: boolean, idx: number }
    const senderRunningRef = useRef(false);

    function waitForPermission() {
        return new Promise((resolve) => {
            permissionResolveRef.current = resolve;
        });
    }

    // sendNextBlock now only sends current-index packet (does NOT increment index)
    async function sendNextBlock() {
        const idx = indexRef.current;
        if (idx >= firmware.current.blocks) {
            setProgress("All blocks sent");
            appendLog("All blocks sent.");
            return;
        }
        setProgress(`Sending block ${idx} / ${firmware.current.blocks - 1}`);
        const p = buildFWPacket(idx);
        await sendBytes(p);
    }

    // Sender loop: sends current block, waits for device confirmation (via handleIncoming),
    // then increments index or retries based on device response.
    async function startSenderLoop() {
        if (senderRunningRef.current) return;
        senderRunningRef.current = true;

        try {
            while (indexRef.current < firmware.current.blocks) {
                // Send current block
                await sendNextBlock();

                // Wait for device confirmation (handleIncoming will resolve)
                await waitForPermission();

                const ack = lastAckRef.current;
                lastAckRef.current = null;
                permissionResolveRef.current = null;

                if (ack && ack.ok === true && ack.idx === indexRef.current) {
                    appendLog(`Device confirmed block ${ack.idx}. Advancing to next block.`);
                    indexRef.current++;
                } else if (ack && ack.ok === false) {
                    appendLog(`Device reported error for block ${indexRef.current}. Retrying...`);
                    // retry the same index (loop continues)
                } else {
                    appendLog("No valid ack received, retrying current block.");
                    // conservative retry
                }
            }

            setProgress("All blocks sent");
            appendLog("All blocks sent (sender loop finished).");
        } catch (e) {
            appendLog("Sender loop error: " + e);
        } finally {
            senderRunningRef.current = false;
        }
    }

    // Incoming data handler: accumulate simple parsing and signal sender loop instead of sending directly
    const packetBufRef = useRef([]);
    async function handleIncoming(chunk) {
        const bytes = Array.from(chunk);
        packetBufRef.current.push(...bytes);

        appendLog("RX: " + bytes.map(b => b.toString(16).padStart(2, '0')).join(" "));

        const PACKET_SIZE = 5; // adjust if real incoming packet differs

        while (packetBufRef.current.length >= PACKET_SIZE) {
            // find header 0x55
            if (packetBufRef.current[0] !== 0x55) {
                packetBufRef.current.shift();
                continue;
            }

            if (packetBufRef.current.length < PACKET_SIZE) break;

            const packet = packetBufRef.current.splice(0, PACKET_SIZE);
            const [header, code, len, idx] = packet;

            // Instead of calling sendNextBlock from here, set ack info and resolve sender loop
            if (code === 0x01 && idx === indexRef.current) {
                lastAckRef.current = { ok: true, idx };
                appendLog(`dev approves; index ${idx}`);
                if (permissionResolveRef.current) permissionResolveRef.current();
            } else if (idx === 0xFF || code === 0x00) {
                lastAckRef.current = { ok: false, idx: indexRef.current };
                appendLog(`dev error; repeat index ${indexRef.current}`);
                if (permissionResolveRef.current) permissionResolveRef.current();
            } else {
                appendLog(`Unknown packet: ${packet.map(b => b.toString(16).padStart(2, '0')).join(" ")}`);
            }
        }
    }

    // New: find STATUS.BIN in user-selected directory (uses File System Access API)
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

    // write "UPDFW#" into STATUS.BIN preserving remaining bytes up to 2048
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
                appendLog("Save-As not available (no showSaveFilePicker). Consider running in Electron/Node for reliable writes.");
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
                <label>Firmware HEX: </label>
                <input type="file" accept=".hex" onChange={handleFile} />
                <span style={{ marginLeft: 8 }}>{fileName}</span>
            </div>

            <div style={{ marginBottom: 8 }}>
                <button onClick={startFlash}>Start Flash</button>{" "}
                <button onClick={() => { indexRef.current = 0; appendLog("Index reset to 0"); }}>Reset Index</button>
            </div>

            <div style={{ marginBottom: 8 }}>
                <button onClick={findStatusBin}>Select STATUS.BIN Directory</button>{" "}
                <button onClick={writeUpdFw}>Write UPDFW# to STATUS.BIN</button>
                <span style={{ marginLeft: 8 }}>{statusFileName}</span>
            </div>

            <div style={{ marginTop: 12 }}>
                <div><strong>Progress:</strong> {progress}</div>
                <textarea readOnly value={log} rows={12} style={{ width: "100%", marginTop: 8 }} />
            </div>
        </div>
    );
}