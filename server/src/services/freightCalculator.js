// Модуль для агрегации данных из различных источников и расчета ставок фрахта
// Версия 4: Интеграция скраперов, читающих из БД, и анализатора сезонности. Удален расчет топливной надбавки.

import { Pool } from 'pg';
import dotenv from 'dotenv';

// Импорт МОДИФИЦИРОВАННЫХ модулей скраперов (читают из БД) - Используем именованные импорты (ESM)
import { getSCFIDataForCalculation } from './scfi_scraper.js';
import { getFBXDataForCalculation } from './fbx_scraper.js';
import { getWCIDataForCalculation } from './wci_scraper.js';
import { getXenetaDataForCalculation } from './xeneta_scraper.js';
import { getCCFIDataForCalculation } from './ccfi_scraper.js';
import { getCfiDataForCalculation } from './cfi_scraper.js'; // Используем созданную заглушку
import { getHarpexDataForCalculation } from './harpex_scraper.js';
import { getNewConTexDataForCalculation } from './contex_scraper.js'; // NewConTex
import { getBdiDataForCalculation } from './bdi_scraper.js';

// Импорт модуля анализа сезонности
import { fetchSeasonalityFactor } from './seasonality_analyzer.js';

// НЕ ИСПОЛЬЗУЕТСЯ: import fuelSurchargeCalculator from './fuel_surcharge_calculator.js';
// НЕ ИСПОЛЬЗУЕТСЯ: import scraperAdapters from './scraper_adapters.js';
// НЕ ИСПОЛЬЗУЕТСЯ: import webSearchIndices from './web_search_indices.js';

// Загрузка переменных окружения
dotenv.config();

// Подключение к базе данных
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
    // sslmode: 'require' // Раскомментируйте, если ваша БД требует SSL
  }
});

// --- Вспомогательные функции --- (Оставляем без изменений getPortRegionById)

// Вспомогательная функция для определения региона порта по его ID
async function getPortRegionById(portId) {
  try {
    // Сначала проверяем основные регионы из нашей модели
    const regionMap = {
        // Asia (включая China)
        'CNSHA': 'Asia', 'CNYTN': 'Asia', 'CNNGB': 'Asia', 'CNQIN': 'Asia', 'CNDAL': 'Asia', 'CNXMN': 'Asia', 'CNTAO': 'Asia',
        'HKHKG': 'Asia', 'SGSIN': 'Asia', 'JPOSA': 'Asia', 'JPTYO': 'Asia', 'KRPUS': 'Asia', 'VNSGN': 'Asia', 'MYLPK': 'Asia', 'IDTPP': 'Asia', 'THBKK': 'Asia', 'PHMNL': 'Asia', 'TWKHH': 'Asia',
        // Europe
        'DEHAM': 'Europe', 'NLRTM': 'Europe', 'GBFXT': 'Europe', 'FRLEH': 'Europe', 'BEANR': 'Europe', 'ESBCN': 'Europe', 'ITGOA': 'Europe', 'GRPIR': 'Europe', 'PLGDN': 'Europe', 'SEGOT': 'Europe', 'FILIV': 'Europe',
        // Mediterranean (отдельно от Europe)
        'ITTRS': 'Mediterranean', 'ESVLC': 'Mediterranean', 'FRFOS': 'Mediterranean', 'TRMER': 'Mediterranean', 'EGPSD': 'Mediterranean', 'MTMAR': 'Mediterranean', 'HRRJK': 'Mediterranean',
        // North America
        'USLAX': 'North America', 'USLGB': 'North America', 'USSEA': 'North America', 'USNYC': 'North America', 'USBAL': 'North America', 'USSAV': 'North America', 'USHOU': 'North America', 'CAMTR': 'North America', 'CAVNC': 'North America', 'USOAK': 'North America',
        // South America
        'BRSSZ': 'South America', 'ARBUE': 'South America', 'CLVAP': 'South America', 'PECLL': 'South America', 'COBUN': 'South America', 'ECGYE': 'South America', 'BRRIO': 'South America',
        // Oceania
        'AUSYD': 'Oceania', 'AUMEL': 'Oceania', 'NZAKL': 'Oceania', 'AUBNE': 'Oceania',
        // Africa
        'ZALGS': 'Africa', 'ZADUR': 'Africa', 'MAPTM': 'Africa', 'EGALY': 'Africa', 'TZDAR': 'Africa', 'KEMBA': 'Africa', 'SNDKR': 'Africa', 'CMKBI': 'Africa',
        // Middle East
        'AEJEA': 'Middle East', 'AEDXB': 'Middle East', 'SAJED': 'Middle East', 'IQBSR': 'Middle East', 'IRBND': 'Middle East', 'OMMUS': 'Middle East', 'QAHMD': 'Middle East'
      };
      if (regionMap[portId]) {
          return regionMap[portId];
      }

    // Если нет в карте, пробуем запросить из БД
    const query = `SELECT region FROM ports WHERE id = $1`;
    const result = await pool.query(query, [portId]);
    if (result.rows.length > 0 && result.rows[0].region) {
        // Приводим регион из БД к нашим стандартным именам, если нужно
        const dbRegion = result.rows[0].region;
        // Простой маппинг (можно расширить)
        if (dbRegion.toLowerCase().includes('china')) return 'Asia';
        if (dbRegion.toLowerCase().includes('asia')) return 'Asia';
        if (dbRegion.toLowerCase().includes('europe')) return 'Europe';
        if (dbRegion.toLowerCase().includes('mediterranean')) return 'Mediterranean';
        if (dbRegion.toLowerCase().includes('north america')) return 'North America';
        if (dbRegion.toLowerCase().includes('south america')) return 'South America';
        if (dbRegion.toLowerCase().includes('oceania')) return 'Oceania';
        if (dbRegion.toLowerCase().includes('africa')) return 'Africa';
        if (dbRegion.toLowerCase().includes('middle east')) return 'Middle East';
        return dbRegion; // Возвращаем как есть, если не совпало
    } else {
      console.warn(`Region not found in map or DB for port ${portId}. Returning 'Unknown'.`);
      return 'Unknown';
    }
  } catch (error) {
    console.error(`Error getting region for port ${portId}:`, error);
    return 'Unknown';
  }
}

// Функция для получения базовой ставки (ИСПОЛЬЗУЕТ ПЕРЕДАННЫЙ baseRatesConfig)
function getBaseRate(originRegion, destinationRegion, containerType, baseRatesConfig, debugLog) {
    const step = { stage: 'Get Base Rate', inputs: { originRegion, destinationRegion, containerType }, result: null, status: 'Failed' };
    try {
        // Нормализация типа контейнера (пример)
        let normalizedContainerType = containerType.toUpperCase();
        if (normalizedContainerType.includes('20')) normalizedContainerType = '20DV';
        else if (normalizedContainerType.includes('40HC') || normalizedContainerType.includes('40 HQ')) normalizedContainerType = '40HC';
        else if (normalizedContainerType.includes('40')) normalizedContainerType = '40DV';
        else normalizedContainerType = 'Unknown'; // Неизвестный тип

        step.inputs.normalizedContainerType = normalizedContainerType;

        let rate = baseRatesConfig[originRegion]?.[destinationRegion]?.[normalizedContainerType];

        // Fallback, если точный маршрут не найден
        if (rate === undefined) {
            step.details = `Exact route ${originRegion}->${destinationRegion} ${normalizedContainerType} not found. Trying fallbacks.`;
            // 1. Пробуем default для региона отправления
            rate = baseRatesConfig[originRegion]?.["Unknown"]?.[normalizedContainerType];
            if (rate !== undefined) {
                step.details += ` Used default for origin region ${originRegion}.`;
            } else {
                // 2. Пробуем global default
                rate = baseRatesConfig["Unknown"]?.["Unknown"]?.[normalizedContainerType];
                if (rate !== undefined) {
                    step.details += ` Used global default.`;
                } else {
                    // 3. Совсем крайний случай
                    rate = 2000; // Абсолютный fallback
                    step.details += ` Used absolute fallback value ${rate}.`;
                }
            }
        }

        step.result = rate;
        step.status = 'Success';
        debugLog.push(step);
        return rate;
    } catch (error) {
        step.status = 'Error';
        step.error = error.message;
        console.error('Error getting base rate:', error);
        debugLog.push(step);
        return 2000; // Возвращаем fallback при ошибке
    }
}

// Функция для расчета взвешенного индекса (ИСПОЛЬЗУЕТ ДАННЫЕ ИЗ indexConfig)
function calculateWeightedIndex(indexConfig, debugLog) {
    const step = { stage: 'Calculate Weighted Index', inputs: {}, totalWeightUsed: 0, weightedSum: 0, result: 1.0, status: 'Failed', details: '' }; // Default result 1.0
    let sourcesUsed = [];

    try {
        if (!indexConfig || Object.keys(indexConfig).length === 0) {
            step.details = 'Index configuration is empty or missing. Using default index value 1.0.';
            step.status = 'Warning';
            debugLog.push(step);
            return { value: 1.0, sources: [] }; // Return default if no config
        }

        for (const indexName in indexConfig) {
            const config = indexConfig[indexName];

            // Пропускаем индексы с нулевым весом или отсутствующие/неполные данные
            if (!config || config.weight_percentage <= 0 || config.baseline_value === undefined || config.current_value === undefined) {
                step.inputs[indexName] = { expected: true, found: false, reason: 'Zero weight or missing data in config', baseline: config?.baseline_value, weight: config?.weight_percentage, current: config?.current_value };
                continue;
            }

            const currentValue = parseFloat(config.current_value);
            const baselineValue = parseFloat(config.baseline_value);
            const weight = parseFloat(config.weight_percentage) / 100.0; // Преобразуем % в долю

            step.inputs[indexName] = { expected: true, found: false, value: currentValue, baseline: baselineValue, weight: weight * 100, current: currentValue };

            if (!isNaN(currentValue) && baselineValue > 0 && !isNaN(weight)) {
                const indexRatio = currentValue / baselineValue;
                step.weightedSum += weight * indexRatio;
                step.totalWeightUsed += weight;
                step.inputs[indexName].found = true;
                step.inputs[indexName].ratio = indexRatio.toFixed(3);
                sourcesUsed.push(indexName);
            } else {
                 step.inputs[indexName].reason = `Invalid data: currentValue=${currentValue}, baselineValue=${baselineValue}, weight=${weight}`;
                 step.details += `Skipped ${indexName} due to invalid data. `;
            }
        }

        if (step.totalWeightUsed > 0) {
            // Нормализуем, если сумма весов не равна 1 (хотя должна быть)
            const normalizedWeightedSum = step.weightedSum / step.totalWeightUsed;
            step.result = normalizedWeightedSum;
            step.status = 'Success';
            step.details = `Calculated weighted index using: ${sourcesUsed.join(', ')}. Total weight used: ${(step.totalWeightUsed * 100).toFixed(1)}%.`;
        } else {
            step.result = 1.0; // Fallback if no valid indices found
            step.status = 'Warning';
            step.details = 'No valid indices with positive weight found in config. Using default index value 1.0.';
        }

        debugLog.push(step);
        return { value: step.result, sources: sourcesUsed };

    } catch (error) {
        step.status = 'Error';
        step.error = error.message;
        console.error('Error calculating weighted index:', error);
        debugLog.push(step);
        return { value: 1.0, sources: [] }; // Return default on error
    }
}

// --- Основная функция расчета (Адаптированная, принимает конфигурацию как параметры) --- 
// ЭКСПОРТИРУЕМАЯ ФУНКЦИЯ
export async function calculateFreightRate(originPortId, destinationPortId, containerType, baseRatesConfig, indexConfig, sensitivityCoeff, weight = 20000, debugMode = false) {
  const debugLog = [];
  const startTime = Date.now();
  let calculationStatus = 'Started';

  if (debugMode) {
    debugLog.push({ stage: 'Start Calculation (Excel Model v4)', inputs: { originPortId, destinationPortId, containerType, weight }, timestamp: new Date().toISOString() });
  }

  try {
    // 1. Получение регионов
    const originRegion = await getPortRegionById(originPortId);
    const destinationRegion = await getPortRegionById(destinationPortId);
    if (debugMode) {
        debugLog.push({ stage: 'Get Regions', inputs: { originPortId, destinationPortId }, result: { originRegion, destinationRegion }, status: 'Success' });
    }

    // 2. Получение базовой ставки
    const baseRate = getBaseRate(originRegion, destinationRegion, containerType, baseRatesConfig, debugLog);

    // 3. Расчет взвешенного индекса (использует indexConfig, который уже содержит current_value из БД)
    const weightedIndex = calculateWeightedIndex(indexConfig, debugLog);

    // 4. Получение коэффициента сезонности
    const currentMonth = new Date().getMonth() + 1;
    let seasonalityFactor = { factor: 1.0, confidence: 0 }; // Default
    const seasonalityStep = { stage: 'Get Seasonality Factor', inputs: { originRegion, destinationRegion, currentMonth }, result: seasonalityFactor, status: 'Failed' };
    try {
        seasonalityFactor = await fetchSeasonalityFactor(originRegion, destinationRegion, currentMonth);
        seasonalityStep.result = seasonalityFactor;
        seasonalityStep.status = 'Success';
    } catch (error) {
        seasonalityStep.status = 'Error';
        seasonalityStep.error = error.message;
        console.error('Error getting seasonality factor:', error);
    }
    debugLog.push(seasonalityStep);

    // 5. Расчет финальной ставки (БЕЗ топливной надбавки)
    const finalRateStep = { stage: 'Calculate Final Rate', inputs: { baseRate, weightedIndex: weightedIndex.value, seasonalityFactor: seasonalityFactor.factor, sensitivityCoeff }, result: null, status: 'Failed' };
    let finalRate = 0;
    try {
        // Формула: Базовая ставка * (1 + (Взвешенный индекс - 1) * Чувствительность) * Сезонный коэффициент
        // Если взвешенный индекс = 1, то множитель = 1
        // Если взвешенный индекс > 1, то множитель > 1
        // Если взвешенный индекс < 1, то множитель < 1
        const indexAdjustment = 1 + (weightedIndex.value - 1) * sensitivityCoeff;
        finalRate = baseRate * indexAdjustment * seasonalityFactor.factor;
        finalRate = Math.max(0, Math.round(finalRate)); // Округляем и гарантируем неотрицательность

        finalRateStep.inputs.indexAdjustment = indexAdjustment.toFixed(4);
        finalRateStep.result = finalRate;
        finalRateStep.status = 'Success';
    } catch (error) {
        finalRateStep.status = 'Error';
        finalRateStep.error = error.message;
        console.error('Error calculating final rate:', error);
        finalRate = baseRate; // Fallback к базовой ставке при ошибке расчета
        finalRateStep.result = finalRate;
    }
    debugLog.push(finalRateStep);

    calculationStatus = 'Completed';
    const endTime = Date.now();
    const duration = endTime - startTime;

    if (debugMode) {
        debugLog.push({ stage: 'End Calculation', status: calculationStatus, durationMs: duration, timestamp: new Date().toISOString() });
    }

    return {
      finalRate,
      baseRate,
      weightedIndex: weightedIndex.value,
      seasonalityFactor: seasonalityFactor.factor,
      // fuelSurcharge: 0, // Топливная надбавка не используется
      calculationDetails: {
        originRegion,
        destinationRegion,
        indexSources: weightedIndex.sources,
        seasonalityConfidence: seasonalityFactor.confidence,
        sensitivityCoeff,
        calculationTimeMs: duration
      },
      debugLog: debugMode ? debugLog : undefined
    };

  } catch (error) {
    console.error('Critical error during freight rate calculation:', error);
    calculationStatus = 'Failed';
    const endTime = Date.now();
    const duration = endTime - startTime;
    if (debugMode) {
        debugLog.push({ stage: 'Critical Error', error: error.message, stack: error.stack, status: calculationStatus, durationMs: duration, timestamp: new Date().toISOString() });
    }
    // Возвращаем ошибку или fallback значение
    return {
        finalRate: -1, // Индикатор ошибки
        error: 'Failed to calculate freight rate due to a critical error.',
        calculationDetails: { calculationTimeMs: duration },
        debugLog: debugMode ? debugLog : undefined
    };
  }
}

// --- Функции для работы с историей (Оставляем без изменений) ---

// Функция для сохранения запроса в историю
// ЭКСПОРТИРУЕМАЯ ФУНКЦИЯ
export async function saveRequestToHistory(originPort, destinationPort, containerType, weight, finalRate, email, sources) {
  try {
    const query = `
      INSERT INTO calculation_history 
      (origin_port_id, destination_port_id, container_type, weight, rate, email, sources, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `;
    await pool.query(query, [originPort, destinationPort, containerType, weight, finalRate, email, JSON.stringify(sources)]);
    console.log('Calculation request saved to history.');
  } catch (error) {
    console.error('Error saving calculation request to history:', error);
    // Не пробрасываем ошибку, чтобы не прерывать основной процесс
  }
}

// Пример использования (для тестирования модуля)
/*
async function testCalculation() {
    // Загрузка статической конфигурации (пример)
    const baseRatesConfig = {
        'Asia': { 'Europe': { '40HC': 2500 } },
        'Unknown': { 'Unknown': { '40HC': 2000 } }
    };
    const indexConfig = {
        'SCFI': { current_value: 1100, baseline_value: 1000, weight_percentage: 50 },
        'FBX': { current_value: 1300, baseline_value: 1200, weight_percentage: 50 }
    };
    const sensitivityCoeff = 0.5;

    const result = await calculateFreightRate('CNSHA', 'NLRTM', '40HC', baseRatesConfig, indexConfig, sensitivityCoeff, 20000, true);
    console.log('Test Calculation Result:', JSON.stringify(result, null, 2));

    if (result.finalRate !== -1) {
        await saveRequestToHistory('CNSHA', 'NLRTM', '40HC', 20000, result.finalRate, 'test@example.com', result.calculationDetails.indexSources);
    }
}

testCalculation();
*/
