const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const Tesseract = require('tesseract.js');

const TELEGRAM_TOKEN = '9158462618:AAGW2hRJj8oAeAti8ZUbmavH-duH3GcD7Js';
const SPREADSHEET_ID = '1hGeN8I4LBPl92VRlEzl4Dh3eME4YY6NnILFUQDnIx_8';

const bot = new Telegraf(TELEGRAM_TOKEN);

bot.catch((err) => {
    console.error('Error Telegraf:', err.message);
});

// 🧠 Smart Parser untuk teks biasa (Kategori Akuntansi Standar)
function parseFinancialData(text) {
    let cleanText = text.toLowerCase().replace(/\./g, '').replace(/,/g, '.');
    let nominal = 0;

    if (cleanText.includes('jt') || cleanText.includes('juta')) {
        let match = cleanText.match(/([\d\.]+)\s*(jt|juta)/);
        if (match) nominal = Math.round(parseFloat(match[1]) * 1000000);
    } else if (cleanText.includes('rb') || cleanText.includes('ribu') || cleanText.includes('k')) {
        let match = cleanText.match(/([\d\.]+)\s*(rb|ribu|k)/);
        if (match) nominal = Math.round(parseFloat(match[1]) * 1000);
    } else {
        let numbers = text.match(/\d+/g);
        nominal = numbers ? parseInt(numbers.join('')) : 0;
    }

    let tipe = "Pengeluaran";
    if (cleanText.includes('gaji') || cleanText.includes('terima') || cleanText.includes('masuk') || cleanText.includes('pendapatan') || cleanText.includes('jual')) {
        tipe = "Pemasukan";
    }

    // Chart of Accounts (Kategori Standar Akuntansi)
    let kategori = "Biaya Lain-lain";
    if (cleanText.includes('makan') || cleanText.includes('minum') || cleanText.includes('kopi') || cleanText.includes('snack') || cleanText.includes('mie') || cleanText.includes('nasi')) {
        kategori = "Makanan & Minuman";
    } else if (cleanText.includes('bensin') || cleanText.includes('parkir') || phoneticMatch(cleanText, ['transport', 'gojek', 'grab', 'uber'])) {
        kategori = "Transportasi";
    } else if (cleanText.includes('listrik') || cleanText.includes('token') || cleanText.includes('wifi') || cleanText.includes('pulsa') || cleanText.includes('tagihan')) {
        kategori = "Tagihan & Utilitas";
    } else if (cleanText.includes('gaji') || cleanText.includes('bonus') || cleanText.includes('dividen')) {
        tipe = "Pemasukan";
        kategori = "Pendapatan Utama";
    } else if (cleanText.includes('side hustle') || cleanText.includes('jual')) {
        tipe = "Pemasukan";
        kategori = "Pendapatan Sampingan";
    } else if (cleanText.includes('hiburan') || cleanText.includes('nonton') || cleanText.includes('game')) {
        kategori = "Hiburan";
    } else if (cleanText.includes('belanja') || cleanText.includes('keperluan')) {
        kategori = "Belanja Kebutuhan";
    }

    let keterangan = text
        .replace(/(\d+[\.,]?\d*)\s*(jt|juta|rb|ribu|k)\b/gi, '')
        .replace(/\b(ribu|rb|k|jt|juta|rp|idr)\b/gi, '')
        .replace(/\d+/g, '')
        .trim();

    if (!keterangan) keterangan = "Transaksi Harian";

    return { tipe, kategori, keterangan, nominal, catatan: "-" };
}

function phoneticMatch(text, words) {
    return words.some(w => text.includes(w));
}

// 🔍 Parser Khusus Struk (OCR)
function parseReceiptText(text) {
    let lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let nominal = 0;
    let merchantName = "Belanja Toko";

    for (let line of lines) {
        let lower = line.toLowerCase();
        if (lower.includes('total') || lower.includes('bayar')) {
            let numbers = line.match(/\d+/g);
            if (numbers) {
                let parsed = parseInt(numbers.join(''));
                if (parsed > nominal) nominal = parsed;
            }
        }
    }

    if (nominal === 0) {
        let allNumbers = text.match(/\d+/g);
        if (allNumbers) {
            let parsedNums = allNumbers.map(n => parseInt(n));
            nominal = Math.max(...parsedNums);
        }
    }

    if (lines.length > 0) {
        let cleanFirstLine = lines[0].replace(/[^a-zA-Z\s]/g, '').trim();
        if (cleanFirstLine.length > 2) {
            merchantName = cleanFirstLine;
        }
    }

    return {
        tipe: "Pengeluaran",
        kategori: "Belanja Kebutuhan",
        keterangan: `Struk ${merchantName}`,
        nominal: nominal || 0,
        catatan: "Scan OCR Struk"
    };
}

// Fungsi Simpan ke Sheets, Hitung Saldo Total & Rekap Arus Kas Bulanan
async function appendToSheet(username, data) {
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: 'credentials.json',
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        
        const googleSheets = google.sheets({ version: 'v4', auth });
        
        const getRows = await googleSheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Data!A:H', 
        });

        let currentSaldo = 0;
        let totalPemasukanBulanIni = 0;
        let totalPengeluaranBulanIni = 0;

        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();

        const rows = getRows.data.values;
        if (rows && rows.length > 0) {
            // Ambil saldo berjalan terakhir dari kolom F
            for (let i = rows.length - 1; i >= 0; i--) {
                if (rows[i][5] && !isNaN(rows[i][5])) {
                    currentSaldo = parseFloat(rows[i][5]);
                    break;
                }
            }

            // Hitung akumulasi bulan berjalan khusus bulan & tahun ini
            for (let row of rows) {
                if (!row[0] || !row[1] || !row[4]) continue;
                let dateParts = row[0].split(',')[0].split('/');
                if (dateParts.length === 3) {
                    let rowMonth = parseInt(dateParts[1]) - 1;
                    let rowYear = parseInt(dateParts[2]);

                    if (rowMonth === currentMonth && rowYear === currentYear) {
                        let nominalTrans = parseFloat(row[4]) || 0;
                        if (row[1].toLowerCase().includes('pemasukan')) {
                            totalPemasukanBulanIni += nominalTrans;
                        } else if (row[1].toLowerCase().includes('pengeluaran')) {
                            totalPengeluaranBulanIni += nominalTrans;
                        }
                    }
                }
            }
        }

        // Kalkulasi saldo berjalan dan arus kas bulanan berdasarkan transaksi baru
        if (data.tipe === "Pemasukan") {
            currentSaldo += data.nominal;
            totalPemasukanBulanIni += data.nominal;
        } else {
            currentSaldo -= data.nominal;
            totalPengeluaranBulanIni += data.nominal;
        }

        const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

        await googleSheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Data!A:H', 
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [[
                    timestamp, data.tipe, data.kategori, data.keterangan, 
                    data.nominal, currentSaldo, data.catatan, username
                ]],
            },
        });

        const netBulanIni = totalPemasukanBulanIni - totalPengeluaranBulanIni;

        return { 
            success: true, 
            saldoAkhir: currentSaldo, 
            pemasukanBulanIni: totalPemasukanBulanIni, 
            pengeluaranBulanIni: totalPengeluaranBulanIni,
            netBulanIni: netBulanIni
        };
    } catch (error) {
        console.error('Gagal menulis ke Google Sheets:', error);
        return { success: false };
    }
}

bot.start((ctx) => {
    ctx.reply('🤖 Asisten Akuntansi Keuangan Aktif!\n\nKirim catatan teks transaksi atau foto struk belanja Anda.');
});

// Handler Teks Biasa
bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    const username = ctx.from.username || ctx.from.first_name || 'Anonim';

    const waitingMsg = await ctx.reply('⏳ Memproses jurnal keuangan...');
    const financialData = parseFinancialData(userText);
    const result = await appendToSheet(username, financialData);

    if (result.success) {
        const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
        const currentMonthName = monthNames[new Date().getMonth()];

        const netStatus = result.netBulanIni >= 0 ? "📈 Surplus" : "📉 Defisit";

        const replyText = 
            `✅ JURNAL TRANSAKSI BERHASIL DICATAT\n` +
            `----------------------------------------\n` +
            `📅 Tanggal  : ${new Date().toLocaleString('id-ID')}\n` +
            `📂 Tipe     : ${financialData.tipe}\n` +
            `🏷️ Kategori : ${financialData.kategori}\n` +
            `📝 Uraian   : ${financialData.keterangan}\n` +
            `💰 Nominal  : Rp ${Number(financialData.nominal).toLocaleString('id-ID')}\n` +
            `----------------------------------------\n` +
            `📊 ARUS KAS BULAN ${currentMonthName.toUpperCase()}\n` +
            `📥 Masuk    : Rp ${Number(result.pemasukanBulanIni).toLocaleString('id-ID')}\n` +
            `📤 Keluar   : Rp ${Number(result.pengeluaranBulanIni).toLocaleString('id-ID')}\n` +
            `${netStatus}  : Rp ${Number(result.netBulanIni).toLocaleString('id-ID')}\n` +
            `----------------------------------------\n` +
            `💳 SALDO DOMPET TOTAL: Rp ${Number(result.saldoAkhir).toLocaleString('id-ID')}`;

        ctx.telegram.editMessageText(ctx.chat.id, waitingMsg.message_id, undefined, replyText);
    } else {
        ctx.telegram.editMessageText(ctx.chat.id, waitingMsg.message_id, undefined, `❌ Gagal menyimpan ke Google Sheets.`);
    }
});

// Handler Foto / Struk Belanja dengan OCR & Layout Akuntansi Rapi
bot.on('photo', async (ctx) => {
    const username = ctx.from.username || ctx.from.first_name || 'Anonim';
    const waitingMsg = await ctx.reply('🔍 Memindai struk & menyusun jurnal...');

    try {
        const photoArray = ctx.message.photo;
        const fileId = photoArray[photoArray.length - 1].file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);

        const { data: { text } } = await Tesseract.recognize(fileLink.href, 'ind');
        
        const financialData = parseReceiptText(text);
        const result = await appendToSheet(username, financialData);

        if (result.success) {
            const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
            const currentMonthName = monthNames[new Date().getMonth()];

            const netStatus = result.netBulanIni >= 0 ? "📈 Surplus" : "📉 Defisit";

            const replyText = 
                `✅ JURNAL STRUK BERHASIL DICATAT\n` +
                `----------------------------------------\n` +
                `📅 Tanggal  : ${new Date().toLocaleString('id-ID')}\n` +
                `📂 Tipe     : ${financialData.tipe}\n` +
                `🏷️ Kategori : ${financialData.kategori}\n` +
                `📝 Uraian   : ${financialData.keterangan}\n` +
                `💰 Nominal  : Rp ${Number(financialData.nominal).toLocaleString('id-ID')}\n` +
                `----------------------------------------\n` +
                `📊 ARUS KAS BULAN ${currentMonthName.toUpperCase()}\n` +
                `📥 Masuk    : Rp ${Number(result.pemasukanBulanIni).toLocaleString('id-ID')}\n` +
                `📤 Keluar   : Rp ${Number(result.pengeluaranBulanIni).toLocaleString('id-ID')}\n` +
                `${netStatus}  : Rp ${Number(result.netBulanIni).toLocaleString('id-ID')}\n` +
                `----------------------------------------\n` +
                `💳 SALDO DOMPET TOTAL: Rp ${Number(result.saldoAkhir).toLocaleString('id-ID')}`;

            ctx.telegram.editMessageText(ctx.chat.id, waitingMsg.message_id, undefined, replyText);
        } else {
            ctx.telegram.editMessageText(ctx.chat.id, waitingMsg.message_id, undefined, `❌ Gagal menyimpan data struk ke Google Sheets.`);
        }
    } catch (error) {
        console.error('Error handling photo:', error);
        ctx.telegram.editMessageText(ctx.chat.id, waitingMsg.message_id, undefined, `❌ Gagal memproses gambar struk.`);
    }
});

bot.launch();
console.log('🤖 Bot Akuntansi Keuangan Profesional Berjalan!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));