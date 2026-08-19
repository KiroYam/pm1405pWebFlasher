export function parseIntelHex(text) {
    const bytes = [];
    const lines = text.split(/\r?\n/);
    let total = 0;
    for (const line of lines) {
        if (!line || line[0] !== ":") continue;
        if (line.length < 11) throw new Error("Invalid record");
        const byteCount = parseInt(line.substr(1, 2), 16);
        const recordType = parseInt(line.substr(7, 2), 16);
        if (recordType !== 0) continue; // only data records
        const dataStart = 9;
        if (line.length < dataStart + byteCount * 2) throw new Error("Short record");
        for (let i = 0; i < byteCount; i++) {
            const b = parseInt(line.substr(dataStart + i * 2, 2), 16);
            bytes.push(b & 0xff);
            total++;
        }
    }
    const blocks = Math.ceil(total / 2048);
    return { bytes, blocks };
}