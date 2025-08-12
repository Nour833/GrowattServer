'use strict';
// --- Core Libraries ---
const TelegramBot = require('node-telegram-bot-api');
const api = require('growatt');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { differenceInMinutes, differenceInDays, differenceInHours, format, subDays, startOfWeek, endOfWeek, startOfMonth, endOfMonth, eachDayOfInterval, getDaysInMonth, subWeeks, subMonths, parseISO } = require('date-fns');

// =================================================================
// --- ⚙️ 1. CENTRALIZED CONFIGURATION ---
// =================================================================
const GROWATT_USER = process.env.GROWATT_USER;
const GROWATT_PASSWORD = process.env.GROWATT_PASSWORD;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID;
// --- Bot Behavior DEFAULTS ---
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_COST_PER_KWH = 0.32;
const DEFAULT_CURRENCY_SYMBOL = "TND";
const DEFAULT_CLEANING_WEEKS = 4;
const DEFAULT_TEMP_THRESHOLD_C = 60;
const CHECK_HOUR_START = 10;
const CHECK_HOUR_END = 15;
const URGENT_ALERT_DELAY_MINUTES = 15;
const MILESTONE_STEP_KWH = 1000;
const LIVENESS_CHECK_HOURS = 2;
const HISTORY_DAYS_TO_KEEP = 90;

// --- Bot Initialization ---
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
let state = loadState();
let apiCache = { data: null, timestamp: 0 };

// =================================================================
// --- 🌐 2. INTERNATIONALIZATION (i18n) & HELPERS ---
// =================================================================
const translations = {};
try {
    translations.en = JSON.parse(fs.readFileSync(path.join(__dirname, 'en.json'), 'utf8'));
    translations.fr = JSON.parse(fs.readFileSync(path.join(__dirname, 'fr.json'), 'utf8'));
} catch (error) {
    console.error("CRITICAL: Could not load language files. Exiting.", error);
    process.exit(1);
}

function t(key, lang, variables = {}) {
    const language = lang || state.config.language;
    let text = translations[language]?.[key] || translations[DEFAULT_LANGUAGE]?.[key] || `Missing translation: ${key}`;
    for (const [variable, value] of Object.entries(variables)) {
        text = text.replace(new RegExp(`{${variable}}`, 'g'), value);
    }
    return text;
}

function loadState() {
  try {
    const rawData = fs.readFileSync(path.join(__dirname, 'bot_state.json'));
    const loadedState = JSON.parse(rawData);
    const mergedState = {
      config: { ...{ language: DEFAULT_LANGUAGE, costPerKwh: DEFAULT_COST_PER_KWH, currencySymbol: DEFAULT_CURRENCY_SYMBOL, cleaningIntervalWeeks: DEFAULT_CLEANING_WEEKS, tempThreshold: DEFAULT_TEMP_THRESHOLD_C }, ...loadedState.config },
      stats: { ...{ lastReminderDate: new Date(0), nextMilestoneKwh: MILESTONE_STEP_KWH, bestDay: { date: null, kwh: 0 }, lastLivenessAlert: null, lastTempAlert: null }, ...loadedState.stats },
      status: { ...{ isSystemDown: false, outageStartTime: null, urgentAlertSent: false }, ...loadedState.status }
    };
    mergedState.stats.lastReminderDate = new Date(mergedState.stats.lastReminderDate);
    if (mergedState.status.outageStartTime) {
        mergedState.status.outageStartTime = new Date(mergedState.status.outageStartTime);
    }
    return mergedState;
  } catch (error) {
    console.log("State file not found. Creating a new one with defaults.");
    return {
      config: { language: DEFAULT_LANGUAGE, costPerKwh: DEFAULT_COST_PER_KWH, currencySymbol: DEFAULT_CURRENCY_SYMBOL, cleaningIntervalWeeks: DEFAULT_CLEANING_WEEKS, tempThreshold: DEFAULT_TEMP_THRESHOLD_C },
      stats: { lastReminderDate: new Date(0), nextMilestoneKwh: MILESTONE_STEP_KWH, bestDay: { date: null, kwh: 0 }, lastLivenessAlert: null, lastTempAlert: null },
      status: { isSystemDown: false, outageStartTime: null, urgentAlertSent: false }
    };
  }
}

function saveState() { fs.writeFileSync(path.join(__dirname, 'bot_state.json'), JSON.stringify(state, null, 2)); }

async function getGrowattData(forceNew = false, date = new Date()) {
    const isToday = format(date, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');
    if (!forceNew && isToday && apiCache.data && (Date.now() - apiCache.timestamp < 120000)) {
        return apiCache.data;
    }
    const growatt = new api({});
    try {
        await growatt.login(GROWATT_USER, GROWATT_PASSWORD);
        const allPlantData = await growatt.getAllPlantData({ historyLastStartDate: date, historyLastEndDate: date });
        await growatt.logout();
        if (isToday) {
            apiCache = { data: allPlantData, timestamp: Date.now() };
        }
        return allPlantData;
    } catch (e) {
        console.error("Failed to get Growatt data:", e);
        throw new Error(t('ERROR_API_CONNECTION', state.config.language));
    }
}

function formatMarkdown(text, lang = state.config.language) {
    bot.sendMessage(TELEGRAM_GROUP_ID, text, { parse_mode: 'Markdown' })
       .catch(e => console.error(`Failed to send message: ${e.response?.body || e.message}`));
}

async function isAdmin(userId) {
    try {
        const admins = await bot.getChatAdministrators(TELEGRAM_GROUP_ID);
        return admins.some(admin => admin.user.id === userId);
    } catch (e) { return false; }
}

// =================================================================
// --- 💬 3. COMMAND HANDLERS ---
// =================================================================
const commandMap = {
  'status': { cmd: 'GET_STATUS', lang: 'en' }, 'statut': { cmd: 'GET_STATUS', lang: 'fr' },
  'today': { cmd: 'GET_TODAY', lang: 'en' }, 'production': { cmd: 'GET_TODAY', lang: 'en' }, "aujourd'hui": { cmd: 'GET_TODAY', lang: 'fr' },
  'total': { cmd: 'GET_TOTAL', lang: 'en' },
  'money': { cmd: 'GET_MONEY_TODAY', lang: 'en' }, 'argent': { cmd: 'GET_MONEY_TODAY', lang: 'fr' },
  'total money': { cmd: 'GET_MONEY_TOTAL', lang: 'en' }, 'argent total': { cmd: 'GET_MONEY_TOTAL', lang: 'fr' },
  'cleaned': { cmd: 'MARK_CLEANED', lang: 'en' }, 'nettoyé': { cmd: 'MARK_CLEANED', lang: 'fr' },
  'cleaning': { cmd: 'GET_CLEANING_STATUS', lang: 'en' }, 'nettoyage': { cmd: 'GET_CLEANING_STATUS', lang: 'fr' },
  'compare': { cmd: 'GET_COMPARISON', lang: 'en' }, 'comparer': { cmd: 'GET_COMPARISON', lang: 'fr' },
  'weather': { cmd: 'GET_WEATHER', lang: 'en' }, 'meteo': { cmd: 'GET_WEATHER', lang: 'fr' },
  'history': { cmd: 'GET_HISTORY', lang: 'en' }, 'historique': { cmd: 'GET_HISTORY', lang: 'fr' },
  'help': { cmd: 'GET_HELP', lang: 'en' }, 'aide': { cmd: 'GET_HELP', lang: 'fr' },
  '/setlang': { cmd: 'SET_LANG', lang: 'en' },
  '/setcost': { cmd: 'SET_COST', lang: 'en' },
  '/setcleaning': { cmd: 'SET_CLEANING_WEEKS', lang: 'en' },
  '/settemp': { cmd: 'SET_TEMP_THRESHOLD', lang: 'en' },
};

const commandActions = {
    GET_STATUS, GET_TODAY, GET_TOTAL, GET_MONEY_TODAY, GET_MONEY_TOTAL, MARK_CLEANED,
    GET_CLEANING_STATUS, GET_COMPARISON, GET_WEATHER, GET_HISTORY, GET_HELP, SET_LANG, SET_COST,
    SET_CLEANING_WEEKS, SET_TEMP_THRESHOLD
};

bot.on('message', async (msg) => {
    if (!msg.text || msg.from.is_bot) return;
    const commandParts = msg.text.toString().toLowerCase().trim().split(' ');
    const commandKeyword = commandParts.length > 1 && commandMap[`${commandParts[0]} ${commandParts[1]}`] ? `${commandParts[0]} ${commandParts[1]}` : commandParts[0];
    const commandInfo = commandMap[commandKeyword];

    if (commandInfo && commandActions[commandInfo.cmd]) {
        console.log(`Command received: "${commandInfo.cmd}" from ${msg.from.first_name} in lang: ${commandInfo.lang}`);
        if (commandInfo.cmd.startsWith('SET_')) {
            if (await isAdmin(msg.from.id)) { commandActions[commandInfo.cmd](msg, commandInfo.lang); }
            else { formatMarkdown(t('ERROR_NOT_ADMIN', commandInfo.lang)); }
        } else {
            commandActions[commandInfo.cmd](msg, commandInfo.lang);
        }
    }
});

// --- Command Implementations ---
async function GET_STATUS(msg, lang) {
  try {
    const data = await getGrowattData();
    const plant = data[Object.keys(data)[0]];
    const device = plant.devices[Object.keys(plant.devices)[0]];
    formatMarkdown(t('STATUS_REPLY', lang, { pac: device.historyLast.pac, vacr: device.historyLast.vacr, temperature: device.historyLast.temperature, eToday: device.deviceData.eToday }));
  } catch (e) { formatMarkdown(t('ERROR_GENERIC', lang, { errorMessage: e.message })); }
}
async function GET_TODAY(msg, lang) {
  try {
    const data = await getGrowattData();
    const eToday = data[Object.keys(data)[0]].devices[Object.keys(data[Object.keys(data)[0]].devices)[0]].deviceData.eToday;
    formatMarkdown(t('TODAY_REPLY', lang, { eToday }));
  } catch (e) { formatMarkdown(t('ERROR_GENERIC', lang, { errorMessage: e.message })); }
}
async function GET_TOTAL(msg, lang) {
  try {
    const data = await getGrowattData();
    const eTotal = data[Object.keys(data)[0]].plantData.eTotal;
    formatMarkdown(t('TOTAL_REPLY', lang, { eTotal }));
  } catch (e) { formatMarkdown(t('ERROR_GENERIC', lang, { errorMessage: e.message })); }
}
async function GET_MONEY_TODAY(msg, lang) {
  try {
    const data = await getGrowattData();
    const eToday = parseFloat(data[Object.keys(data)[0]].devices[Object.keys(data[Object.keys(data)[0]].devices)[0]].deviceData.eToday);
    const moneySaved = (eToday * state.config.costPerKwh).toFixed(2);
    formatMarkdown(t('MONEY_TODAY_REPLY', lang, { symbol: state.config.currencySymbol, moneySaved }));
  } catch (e) { formatMarkdown(t('ERROR_GENERIC', lang, { errorMessage: e.message })); }
}
async function GET_MONEY_TOTAL(msg, lang) {
  try {
    const data = await getGrowattData();
    const eTotal = parseFloat(data[Object.keys(data)[0]].plantData.eTotal);
    const moneySaved = (eTotal * state.config.costPerKwh).toFixed(2);
    formatMarkdown(t('MONEY_TOTAL_REPLY', lang, { symbol: state.config.currencySymbol, moneySaved }));
  } catch (e) { formatMarkdown(t('ERROR_GENERIC', lang, { errorMessage: e.message })); }
}
function MARK_CLEANED(msg, lang) {
  state.stats.lastReminderDate = new Date();
  saveState();
  formatMarkdown(t('CLEANED_REPLY', lang, { nextReminderDays: state.config.cleaningIntervalWeeks * 7 }));
}
function GET_CLEANING_STATUS(msg, lang) {
  const totalIntervalDays = state.config.cleaningIntervalWeeks * 7;
  const daysPassed = differenceInDays(new Date(), new Date(state.stats.lastReminderDate));
  const daysLeft = totalIntervalDays - daysPassed;
  if (daysLeft <= 0) {
    formatMarkdown(t('CLEANING_OVERDUE_REPLY', lang, { daysOverdue: -daysLeft }));
  } else {
    formatMarkdown(t('CLEANING_STATUS_REPLY', lang, { daysLeft }));
  }
}

async function GET_HISTORY(msg, lang) {
    try {
        let arg = msg.text.split(' ')[1] || format(new Date(), 'yyyy-MM');
        if (/^\d{2}-\d{2}$/.test(arg)) {
            arg = new Date().getFullYear() + '-' + arg;
        }

        if (/^\d{4}$/.test(arg)) { // Year
            formatMarkdown("Fetching yearly report, this might take a moment...");
            const year = parseInt(arg, 10);
            let totalKwh = 0;
            let results = [];
            for (let i = 0; i < 12; i++) {
                const monthDate = new Date(year, i, 1);
                const monthTotal = await getPeriodTotal(monthDate, 'month');
                if (monthTotal > 0) {
                    results.push(`*${format(monthDate, 'yyyy-MM')}:* ${monthTotal.toFixed(2)} kWh`);
                }
                totalKwh += monthTotal;
            }
            if (totalKwh > 0) {
                results.unshift(`*${arg} Total: ${totalKwh.toFixed(2)} kWh*`);
                formatMarkdown(results.join('\n'));
            } else {
                formatMarkdown(t('HISTORY_NOT_FOUND', lang, { date: arg }));
            }
        } else if (/^\d{4}-\d{2}$/.test(arg)) { // Month
            const monthDate = new Date(`${arg}-01T12:00:00`);
            const monthTotal = await getPeriodTotal(monthDate, 'month');
            if (monthTotal > 0) {
                formatMarkdown(t('HISTORY_REPLY', lang, { date: arg, kwh: monthTotal.toFixed(2) }));
            } else {
                formatMarkdown(t('HISTORY_NOT_FOUND', lang, { date: arg }));
            }
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) { // Day
            const kwh = await getPeriodTotal(new Date(arg), 'day');
            if (kwh > 0) {
                formatMarkdown(t('HISTORY_REPLY', lang, { date: arg, kwh: kwh.toFixed(2) }));
            } else {
                formatMarkdown(t('HISTORY_NOT_FOUND', lang, { date: arg }));
            }
        } else {
            formatMarkdown(t('ERROR_HISTORY_FORMAT', lang));
        }
    } catch (e) {
        console.error("Error in GET_HISTORY:", e);
        formatMarkdown(t('ERROR_GENERIC', lang, { errorMessage: e.message }));
    }
}

async function GET_COMPARISON(msg, lang) {
    try {
        const today = new Date();
        const dayComparisonText = compareValues(await getPeriodTotal(today, 'day'), await getPeriodTotal(subDays(today, 1), 'day'), lang);
        const weekComparisonText = compareValues(await getPeriodTotal(today, 'week'), await getPeriodTotal(subWeeks(today, 1), 'week'), lang);
        const monthComparisonText = compareValues(await getPeriodTotal(today, 'month'), await getPeriodTotal(subMonths(today, 1), 'month'), lang);
        formatMarkdown(t('COMPARE_REPLY', lang, { dayComparison: dayComparisonText, weekComparison: weekComparisonText, monthComparison: monthComparisonText }));
    } catch (e) {
        console.error("Error in GET_COMPARISON:", e);
        formatMarkdown(t('ERROR_GENERIC', lang, { errorMessage: e.message }));
    }
}

function compareValues(current, previous, lang) {
    if (previous > 0) {
        const diff = ((current - previous) / previous) * 100;
        return t('COMPARE_PERFORMANCE', lang, { current: current.toFixed(2), previous: previous.toFixed(2), sign: diff >= 0 ? '+' : '', diff: diff.toFixed(0) });
    } else if (current > 0 && previous <= 0) {
         return t('COMPARE_PERFORMANCE', lang, { current: current.toFixed(2), previous: previous.toFixed(2), sign: '+', diff: '∞' });
    }
    return t('COMPARE_NOT_ENOUGH_DATA', lang);
}

async function getPeriodTotal(date, period) {
    if (period === 'day') {
        const data = await getGrowattData(true, date);
        const plant = data[Object.keys(data)[0]];
        if (!plant) return 0;
        const device = plant.devices[Object.keys(plant.devices)[0]];
        if (!device || !device.historyLast) return 0;
        return parseFloat(device.historyLast.eacToday || 0);
    }

    const options = { weekStartsOn: 1 };
    let interval;
    if (period === 'week') {
        interval = { start: startOfWeek(date, options), end: endOfWeek(date, options) };
    } else { // month
        interval = { start: startOfMonth(date), end: endOfMonth(date) };
    }

    let total = 0;
    for (const day of eachDayOfInterval(interval)) {
        const dayTotal = await getPeriodTotal(day, 'day');
        total += dayTotal;
    }
    return total;
}

async function GET_WEATHER(msg, lang) {
    try {
        const data = await getGrowattData();
        const weatherData = data[Object.keys(data)[0]].weather.data.HeWeather6[0].now;
        const iconMap = { "100": "☀️", "101": "☁️", "102": "☁️", "103": "🌤️", "104": "☁️", "300": "🌧️", "305": "🌧️", "306": "🌧️", "307": "🌧️", "400": "❄️" };
        formatMarkdown(t('WEATHER_REPLY', lang, { icon: iconMap[weatherData.cond_code] || "🌡️", condition: weatherData.cond_txt, temp: weatherData.tmp, feelsLike: weatherData.fl, humidity: weatherData.hum }));
    } catch (e) { formatMarkdown(t('ERROR_GENERIC', lang, { errorMessage: e.message })); }
}

function GET_HELP(msg, lang) {
    const helpText = [
        t('HELP_HEADER', lang), t('HELP_INTRO', lang), "\n*English | French*", "-----------------------------",
        t('HELP_COMMAND_STATUS', lang), t('HELP_COMMAND_TODAY', lang), t('HELP_COMMAND_TOTAL', lang), t('HELP_COMMAND_MONEY', lang), t('HELP_COMMAND_TOTAL_MONEY', lang),
        t('HELP_COMMAND_CLEANING', lang), t('HELP_COMMAND_CLEANED', lang), t('HELP_COMMAND_COMPARE', lang), t('HELP_COMMAND_WEATHER', lang), t('HELP_COMMAND_HISTORY', lang), t('HELP_COMMAND_HELP', lang)
    ].join('\n');
    formatMarkdown(helpText, lang);
}

function SET_LANG(msg, lang) {
    const newLang = msg.text.split(' ')[1];
    if (newLang === 'en' || newLang === 'fr') { state.config.language = newLang; saveState(); formatMarkdown(t('SET_LANG_SUCCESS', newLang)); }
    else { formatMarkdown(t('ERROR_INVALID_COMMAND', lang)); }
}

function SET_COST(msg, lang) {
    const cost = parseFloat(msg.text.split(' ')[1]);
    if (!isNaN(cost) && cost > 0) { state.config.costPerKwh = cost; saveState(); formatMarkdown(t('SET_COST_SUCCESS', lang, { cost: cost.toFixed(3) })); }
    else { formatMarkdown(t('ERROR_INVALID_COMMAND', lang)); }
}

function SET_CLEANING_WEEKS(msg, lang) {
    const weeks = parseInt(msg.text.split(' ')[1], 10);
    if (!isNaN(weeks) && weeks > 0) { state.config.cleaningIntervalWeeks = weeks; saveState(); formatMarkdown(t('SET_CLEANING_WEEKS_SUCCESS', lang, { weeks })); }
    else { formatMarkdown(t('ERROR_INVALID_COMMAND', lang)); }
}

function SET_TEMP_THRESHOLD(msg, lang) {
    const temp = parseInt(msg.text.split(' ')[1], 10);
    if (!isNaN(temp) && temp > 30) { state.config.tempThreshold = temp; saveState(); formatMarkdown(t('SET_TEMP_THRESHOLD_SUCCESS', lang, { temp })); }
    else { formatMarkdown(t('ERROR_INVALID_COMMAND', lang)); }
}

// =================================================================
// --- 🕒 4. SCHEDULED TASKS ---
// =================================================================
cron.schedule('59 19 * * *', () => runDailyEveningChecks());
cron.schedule('0 21 * * 0', () => runWeeklyReport());
cron.schedule('0 21 1 * *', () => runMonthlyReport());
cron.schedule('5 * * * *', () => runHourlyChecks());
cron.schedule('* * * * *', () => checkUrgentConditions());

async function runDailyEveningChecks() {
    console.log("Running daily evening checks...");
    try {
        const data = await getGrowattData(true);
        const plant = data[Object.keys(data)[0]];
        const device = plant.devices[Object.keys(plant.devices)[0]];
        const eToday = parseFloat(device.deviceData.eToday);
        const eTotal = parseFloat(plant.plantData.eTotal);
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        if (eToday > (state.stats.bestDay.kwh || 0)) {
            formatMarkdown(t('BEST_DAY_MESSAGE', null, { kwh: eToday, old_kwh: state.stats.bestDay.kwh || 0 }));
            state.stats.bestDay = { date: todayStr, kwh: eToday };
        }
        if (eTotal >= state.stats.nextMilestoneKwh) {
            formatMarkdown(t('MILESTONE_MESSAGE', null, { milestone: state.stats.nextMilestoneKwh }));
            state.stats.nextMilestoneKwh = Math.floor(eTotal / MILESTONE_STEP_KWH) * MILESTONE_STEP_KWH + MILESTONE_STEP_KWH;
        }
        if (differenceInDays(new Date(), new Date(state.stats.lastReminderDate)) >= state.config.cleaningIntervalWeeks * 7) {
            formatMarkdown(t('CLEANING_REMINDER', null, { weeks: state.config.cleaningIntervalWeeks }));
            state.stats.lastReminderDate = new Date();
        }
        saveState();
    } catch (e) { console.error("Daily evening check failed:", e.message); }
}

async function runWeeklyReport() {
    console.log("Running weekly report...");
    try {
        const today = new Date();
        const lastWeekStart = startOfWeek(subDays(today, 7), { weekStartsOn: 1 });
        const lastWeekEnd = endOfWeek(subDays(today, 7), { weekStartsOn: 1 });
        let totalKwh = 0, bestDayKwh = 0, bestDayDate = '';
        for (const day of eachDayOfInterval({ start: lastWeekStart, end: lastWeekEnd })) {
            const kwh = await getPeriodTotal(day, 'day');
            totalKwh += kwh;
            if (kwh > bestDayKwh) { bestDayKwh = kwh; bestDayDate = t(format(day, 'EEEE').toLowerCase(), 'en'); }
        }
        if (totalKwh > 0) { formatMarkdown(t('WEEKLY_REPORT', null, { kwh: totalKwh.toFixed(2), bestDay: bestDayDate, bestDayKwh: bestDayKwh.toFixed(2) })); }
    } catch(e) { console.error("Weekly report failed:", e.message); }
}

async function runMonthlyReport() {
    console.log("Running monthly report...");
    try {
        const today = new Date();
        const lastMonthStart = startOfMonth(subMonths(today, 1));
        const lastMonthEnd = endOfMonth(lastMonthStart);
        let totalKwh = 0;
        const daysInMonth = differenceInDays(lastMonthEnd, lastMonthStart) + 1;
        for (const day of eachDayOfInterval({ start: lastMonthStart, end: lastMonthEnd })) {
            totalKwh += await getPeriodTotal(day, 'day');
        }
        if (totalKwh > 0) { formatMarkdown(t('MONTHLY_REPORT', null, { kwh: totalKwh.toFixed(2), avgKwh: (totalKwh / daysInMonth).toFixed(2) })); }
    } catch(e) { console.error("Monthly report failed:", e.message); }
}

async function runHourlyChecks() {
    console.log("Running hourly checks...");
    const currentHour = new Date().getHours();
    if (currentHour < CHECK_HOUR_START || currentHour > CHECK_HOUR_END) {
        console.log("Outside active window. Resetting daytime alerts.");
        if(state.status.isSystemDown) {
            state.status.isSystemDown = false; state.status.outageStartTime = null; state.status.urgentAlertSent = false;
            saveState();
        }
        return;
    }
    console.log("Inside active window. Performing all daytime checks...");
    try {
        const data = await getGrowattData(true);
        const plant = data[Object.keys(data)[0]];
        const device = plant.devices[Object.keys(plant.devices)[0]];
        const pac = device.historyLast.pac;
        const temp = device.historyLast.temperature;
        const lastUpdate = new Date(device.deviceData.lastUpdateTime);
        const hoursSinceUpdate = differenceInHours(new Date(), lastUpdate);
        console.log(`Hourly Check: Temp=${temp}°C, PAC=${pac}W, LastUpdate=${hoursSinceUpdate}h ago`);
        if (hoursSinceUpdate >= LIVENESS_CHECK_HOURS && (!state.stats.lastLivenessAlert || differenceInHours(new Date(), new Date(state.stats.lastLivenessAlert)) >= 6)) {
            formatMarkdown(t('LIVENESS_ALERT', null, { hours: hoursSinceUpdate }));
            state.stats.lastLivenessAlert = new Date();
            saveState();
        }
        if (temp >= state.config.tempThreshold && (!state.stats.lastTempAlert || differenceInHours(new Date(), new Date(state.stats.lastTempAlert)) >= 6)) {
            formatMarkdown(t('TEMP_ALERT', null, { temp, threshold: state.config.tempThreshold }));
            state.stats.lastTempAlert = new Date();
            saveState();
        }
        if (pac > 0 && state.status.isSystemDown) {
            formatMarkdown(t('RECOVERY_MESSAGE', null, { pac }));
            state.status.isSystemDown = false; state.status.outageStartTime = null; state.status.urgentAlertSent = false;
            saveState();
        } else if (pac === 0 && !state.status.isSystemDown) {
            formatMarkdown(t('OUTAGE_MESSAGE', null));
            state.status.isSystemDown = true; state.status.outageStartTime = new Date();
            saveState();
        }
    } catch (e) { console.error("Hourly check failed:", e.message); }
}

function checkUrgentConditions() {
  if (!state.status.isSystemDown || state.status.urgentAlertSent || !state.status.outageStartTime) return;
  const minutesSinceOutage = differenceInMinutes(new Date(), new Date(state.status.outageStartTime));
  if (minutesSinceOutage >= URGENT_ALERT_DELAY_MINUTES) {
    formatMarkdown(t('URGENT_ALERT_MESSAGE', null, { minutes: URGENT_ALERT_DELAY_MINUTES }));
    state.status.urgentAlertSent = true;
    saveState();
  }
}

// =================================================================
// --- 🚀 5. STARTUP ---
// =================================================================
console.log("Growatt Telegram Bot started (Definitive, Polished Ultimate Version).");
formatMarkdown(t('WELCOME', state.config.language));