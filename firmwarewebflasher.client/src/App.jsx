import React, { useRef, useState, useEffect } from "react";
import "./App.css";
import { WebSerialPort } from "./services/webSerial";
import { parseIntelHex } from "./utils/parseIntelHex";
import { computeCRC8, computeCRC16 } from "./utils/crc8";
import pmHex from "./assets/PM1405P.hex?raw";

console.log("App module loaded, pmHex present =", !!pmHex);




export default function App() {
    console.log("App() start render");
    const serial = useRef(new WebSerialPort());
    const firmware = useRef({ bytes: [], blocks: 0 });
    const indexRef = useRef(0);
    const packetBufRef = useRef([]);
    const lastSendTimeRef = useRef(null);

    const timeoutRef = useRef(null);
    const retryCountRef = useRef(0);
    const MAX_RETRIES = 5;

    const [log, setLog] = useState("");
    const [progress, setProgress] = useState("");

    const [portState, setPortState] = useState("closed");
    

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

    // inside the App() component:
    useEffect(() => {
        if (!pmHex) return;
        try {
            const { bytes, blocks } = parseIntelHex(pmHex);
            firmware.current.bytes = bytes;
            firmware.current.blocks = blocks;
            // fileName was initialized from pmHex via useState(...)
            // defer logging to avoid synchronous setState in the effect
            setTimeout(() => appendLog(`Embedded firmware loaded: ${bytes.length} bytes, ${blocks} blocks`), 0);
        } catch (err) {
            setTimeout(() => appendLog("HEX parse error: " + err), 0);
        }
    }, []);

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

    function buildFWPacket2048() {
        const buflen = 2048; // 2052 data + 2 CRC
        const bufwr = new Uint8Array(buflen);               

       
        for (let k = 0; k < 2048; k++) {
            bufwr[k] = 0x07;
        }

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
    
    async function sendPack2000() {
        if (!serial.current.port || serial.current.port.readable === null) {
            appendLog("Open a port first");
            return;
        }
        if (!firmware.current.bytes.length) {
            appendLog("Load firmware first");
            return;
        }        
        packetBufRef.current = [];
        setProgress("Start: send boot command");
        appendLog("Repeat");
        await sendNextBlock(0, 2048);
        
    }

    async function repeatPackSend() {
        if (!serial.current.port || serial.current.port.readable === null) {
            appendLog("Open a port first");
            return;
        }
        if (!firmware.current.bytes.length) {
            appendLog("Load firmware first");
            return;
        }
        packetBufRef.current = [];
        setProgress("Start: send boot command");
        appendLog("Repeat");
        await sendNextBlock();

    }

    const isSendingRef = useRef(false);

    function clearResponseTimeout() {
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }
    }

    function scheduleResponseTimeout() {
        clearResponseTimeout();
        timeoutRef.current = setTimeout(async () => {
            await onResponseTimeout();
        }, 500);
    }

    async function onResponseTimeout() {
        const idx = indexRef.current;
        if (retryCountRef.current >= MAX_RETRIES) {
            appendLog(`No response for block ${idx} after ${MAX_RETRIES} retries. Aborting.`);
            setProgress("Timeout. Aborted.");
            return;
        }
        retryCountRef.current++;
        appendLog(`Timeout waiting for ACK for block ${idx}. Retrying ${retryCountRef.current}/${MAX_RETRIES}...`);
        if (retryCountRef.current == 1) {
            const p = buildFWPacket2048();
            lastSendTimeRef.current = Date.now();
            appendLog(`Resending block ${idx} (retry ${retryCountRef.current})`);
            try {
                // send without checking isSendingRef to allow retransmit
                await serial.current.sendFWPacket(p);
               // appendLog("Sent: " + Array.from(p).map(b => b.toString(16).padStart(2, '0')).join(" "));
            } catch (e) {
                appendLog("Resend error: " + e);
            } finally {
                scheduleResponseTimeout();
            }
        }
        else {
            const p = buildFWPacket(idx);
            lastSendTimeRef.current = Date.now();
            appendLog(`Resending block ${idx} (retry ${retryCountRef.current})`);
            try {
                // send without checking isSendingRef to allow retransmit
                await serial.current.sendFWPacket(p);
               // appendLog("Sent: " + Array.from(p).map(b => b.toString(16).padStart(2, '0')).join(" "));
            } catch (e) {
                appendLog("Resend error: " + e);
            } finally {
                scheduleResponseTimeout();
            }
        }
    }

    // App.jsx
    async function sendNextBlock(delayMs = 0, value = 2054) {
        if (isSendingRef.current) return;
        isSendingRef.current = true;

        const idx = indexRef.current;
        if (idx >= firmware.current.blocks) {
            setProgress("All blocks sent successfully!");
            appendLog("All blocks sent successfully!");
            isSendingRef.current = false;
            clearResponseTimeout();
            return;
        }

        // starting a new block -> reset retries
        retryCountRef.current = 0;
        clearResponseTimeout();

        setProgress(`Sending block ${idx} / ${firmware.current.blocks - 1}`);
        if (value == 2054) {
            const p = buildFWPacket(idx);


            try {
                packetBufRef.current = []; // очищаем буфер входящих пакетов
                lastSendTimeRef.current = Date.now();
                appendLog(`Sending block ${idx} (sent at ${new Date(lastSendTimeRef.current).toISOString()})`);
                await serial.current.sendFWPacket(p);
               // appendLog("Sent: " + Array.from(p).map(b => b.toString(16).padStart(2, '0')).join(" "));
                // запустить таймаут ожидания ответа
                scheduleResponseTimeout();
            } catch (e) {
                appendLog("Send FW packet error: " + e);
            } finally {
                isSendingRef.current = false;
            }
        }
        else {
            const p = buildFWPacket2048();


            try {
                packetBufRef.current = []; // очищаем буфер входящих пакетов
                lastSendTimeRef.current = Date.now();
                appendLog(`Sending block ${idx} (sent at ${new Date(lastSendTimeRef.current).toISOString()})`);
                await serial.current.sendFWPacket(p);
                //appendLog("Sent: " + Array.from(p).map(b => b.toString(16).padStart(2, '0')).join(" "));
                // запустить таймаут ожидания ответа
                //scheduleResponseTimeout();
            } catch (e) {
                appendLog("Send FW packet error: " + e);
            } finally {
                isSendingRef.current = false;
            }
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

            // ��������� CRC8 �� ������ 4 ������ (slice �������� � Array)
            const crc = computeCRC8(packetBufRef.current.slice(0, 4));


            if (crc != packetBufRef.current[4]) {
                break;
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
                    const rtt = lastSendTimeRef.current ? (Date.now() - lastSendTimeRef.current) : null;

                    // ACK -> очищаем таймаут/счетчик и отправляем следующий блок
                    clearResponseTimeout();
                    retryCountRef.current = 0;

                    indexRef.current++;
                    appendLog(`Block ${idx} ACK (RTT ${rtt} ms) -> next index ${indexRef.current}`);
                    await sendNextBlock(500);
                }
                else if (code === 0x00 && idx === 0xFF) {
                    const rtt = lastSendTimeRef.current ? (Date.now() - lastSendTimeRef.current) : null;
                    appendLog(`Block ${indexRef.current} NACK (RTT ${rtt} ms) -> Flash busy. Waiting 350ms...`);
                    // NACK -> сброс таймаута (чтобы не одновременно с NACK триггерился таймаут),
                    // затем повторим попытку отправки блока
                    clearResponseTimeout();
                    retryCountRef.current = 0;
                    await sendNextBlock(500);
                }
                else
                    appendLog(`request ${packet}`);
            } else {
                appendLog(`(RTT ${rtt} ms) Ignored long packet/echo (packet=${packet}) `);
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
                //appendLog("Primary write failed: " + err);
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
                    //appendLog("Save-As failed: " + saveErr);
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
            <h1>Firmware Web Flasher</h1>
            <h2>1. Switching to boot mode</h2>     
            <h2>Connect PM1405P to the PC</h2>     
            <div style={{ marginBottom: 8 }}>
                <button onClick={findStatusBin}>Find "1405P INFO" & Allow writing to the STATUS.BIN</button>{" "}
                <span style={{ marginLeft: 12 }}>{statusFileName}</span>
            </div>
            <h2>2. Open Port PM1405P</h2>
            <div style={{ marginBottom: 8 }}>
                <button onClick={selectAndOpenPort}>Select & Open Port</button>{" "}
                <button onClick={closePort}>Close Port</button>
                <span style={{ marginLeft: 12 }}>Port: {portState}</span>
            </div>
            <h2>3.Flash firmware</h2>
            <div style={{ marginBottom: 8 }}>
                <button onClick={startFlash}>Flash</button>                
                <span style={{ marginLeft: 12 }}>{progress}</span>
            </div>

           

            <div style={{ marginTop: 12 }}>
                <textarea readOnly value={log} rows={12} cols={80} />
            </div>
        </div>
    );
}