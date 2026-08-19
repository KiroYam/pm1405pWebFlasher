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
        setProgress("Start: send boot command");
        // send enter bootloader command: 0x55,0x04,0xFE,DevAddr,CRC
        //const cmd = new Uint8Array([0x55, 0x04, 0xfe, parseInt(devAddr, 16) & 0xff, 0x00]);
        //cmd[cmd.length - 1] = computeCRC8(cmd.subarray(0, cmd.length - 1));
        //await sendBytes(cmd);
        await sendNextBlock(); // start sending first block immediately
        appendLog("Boot command sent. Waiting device response...");
    }

    // New: send check/info command (C# btnCheck equivalent)
    /*async function sendCheckCommand() {
        if (!serial.current.port || serial.current.port.writable === null) {
            appendLog("Open a port first");
            return;
        }
        const addr = parseInt(devAddr || "0", 16) & 0xff;
        const cmd = new Uint8Array([0x55, 0x04, 0x49, addr, 0x00]);
        cmd[cmd.length - 1] = computeCRC8(cmd.subarray(0, cmd.length - 1));
        await sendBytes(cmd);
        appendLog("Check command sent");
    }*/

    async function sendNextBlock() {
        const idx = indexRef.current;
        if (idx >= firmware.current.blocks) {
            setProgress("All blocks sent");
            appendLog("All blocks sent.");
            /*appendLog("All blocks sent. Sending validate command...");
            // send verify command 0x55,0x04,0x76,DevAddr,CRC
            const cmd = new Uint8Array([0x55, 0x04, 0x76, parseInt(devAddr, 16) & 0xff, 0x00]);
            cmd[cmd.length - 1] = computeCRC8(cmd.subarray(0, cmd.length - 1));
            await sendBytes(cmd);*/
            return;
        }
        setProgress(`Sending block ${idx} / ${firmware.current.blocks - 1}`);
        const p = buildFWPacket(idx);
        await sendBytes(p);
    }

    // Incoming data handler: accumulate simple parsing and trigger next actions
    let packetBuf = [];
    async function handleIncoming(chunk) {
        const bytes = Array.from(chunk);
        packetBuf.push(...bytes);
        appendLog("RX: " + bytes.map(b => b.toString(16).padStart(2, '0')).join(" "));
        // try parse packet as in original: start 0xAA ... compute length
        while (packetBuf.length >= 2) {
            if (packetBuf[0] !== 0x55) {
                // drop until 0x55
                packetBuf.shift();
                continue;
            }            

            if (packetBuf[1] === 0x01) {
                // ack for block, if packet[4] == 0 then increment index like C# logic
                if (packetBuf[1] === 1 && packetBuf[3] === indexRef.current) {
                    indexRef.current++;
                }
                appendLog(`ACK 0x04 received; next index ${indexRef.current}`);
                await sendNextBlock();
            }
            else  {
                // ack for block, if packet[4] == 0 then increment index like C# logic
                
                appendLog(`ACK 0x01 received; next index ${indexRef.current}`);
                await sendNextBlock();
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

    // New: write "UPDFW#" into STATUS.BIN preserving remaining bytes up to 2048
    // Replace the existing writeUpdFw function with this:
    // replace existing writeUpdFw with this:
    // Replace writeUpdFw with this implementation
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
            const cmd = "UPDFW#\r\n"; // C code wrote "%s\r\n"
            const cmdBytes = encoder.encode(cmd);
            const pos = cmdBytes.length;
            const TARGET = 2048;

            // Build output buffer exactly like the C code:
            const out = new Uint8Array(TARGET);
            out.set(cmdBytes.subarray(0, Math.min(cmdBytes.length, TARGET)), 0);
            for (let i = pos; i < TARGET; i++) {
                out[i] = i < original.length ? original[i] : 0x00;
            }

            // Try writing to the original handle first
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
                // If it's a quota error, we'll fall through and try Save-As fallback
                appendLog("Primary write failed: " + err);
                if (!(err && err.name === "QuotaExceededError")) throw err;
            }

            // Fallback: ask user to save to a file (Save As)
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
                    // update stored handle to new one if desired:
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