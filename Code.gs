// Cache manager with versioning and compression
const CacheManager = {
  DURATION: {
    SHORT: 300,    // 5 minutes
    MEDIUM: 3600,  // 1 hour
    LONG: 21600    // 6 hours
  },

  getKey(baseKey, version = '1') {
    return `${baseKey}_v${version}`;
  },

  compress(data) {
    try {
      return Utilities.base64Encode(
        Utilities.zip([Utilities.newBlob(JSON.stringify(data))])
        .getBytes()
      );
    } catch (e) {
      Logger.log('Compression error:', e);
      return JSON.stringify(data);
    }
  },

  decompress(compressed) {
    try {
      const decompressed = Utilities.unzip(
        Utilities.newBlob(
          Utilities.base64Decode(compressed)
        )
      )[0].getDataAsString();
      return JSON.parse(decompressed);
    } catch (e) {
      Logger.log('Decompression error:', e);
      return JSON.parse(compressed);
    }
  },

  get(key, version) {
    const cache = CacheService.getScriptCache();
    const versionedKey = this.getKey(key, version);
    const cached = cache.get(versionedKey);
    
    if (!cached) return null;
    
    try {
      return this.decompress(cached);
    } catch (e) {
      Logger.log('Cache retrieval error:', e);
      cache.remove(versionedKey);
      return null;
    }
  },

  put(key, data, duration, version) {
    const cache = CacheService.getScriptCache();
    const compressed = this.compress(data);
    cache.put(
      this.getKey(key, version),
      compressed,
      duration || this.DURATION.MEDIUM
    );
  },

  remove(key, version) {
    const cache = CacheService.getScriptCache();
    cache.remove(this.getKey(key, version));
  },

  removeAll(keys, version) {
    const cache = CacheService.getScriptCache();
    const versionedKeys = keys.map(key => this.getKey(key, version));
    cache.removeAll(versionedKeys);
  }
};

// Daily transfer configuration
const TransferConfig = {
  SOURCE_SHEET: 'Transactions',
  ARCHIVE_SHEET: 'TransactionsArchive',
  TRIGGER_HOUR: 0, // Midnight (0-23)
  TRIGGER_MINUTE: 0 // Minutes (0-59)
};

// Set up daily trigger
function createDailyTrigger() {
  // Delete any existing triggers with the same function name
  deleteTrigger('transferDailyTransactions');
  
  // Create new trigger to run at specified time
  ScriptApp.newTrigger('transferDailyTransactions')
    .timeBased()
    .atHour(TransferConfig.TRIGGER_HOUR)
    .nearMinute(TransferConfig.TRIGGER_MINUTE)
    .everyDays(1)
    .create();
}

// Delete existing trigger by function name
function deleteTrigger(functionName) {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

// Main function to transfer daily transactions
function transferDailyTransactions() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sourceSheet = ss.getSheetByName(TransferConfig.SOURCE_SHEET);
    let archiveSheet = ss.getSheetByName(TransferConfig.ARCHIVE_SHEET);
    
    // Create archive sheet if it doesn't exist
    if (!archiveSheet) {
      archiveSheet = ss.insertSheet(TransferConfig.ARCHIVE_SHEET);
      // Copy header row from source sheet
      const headers = sourceSheet.getRange(1, 1, 1, sourceSheet.getLastColumn()).getValues();
      archiveSheet.getRange(1, 1, 1, headers[0].length).setValues(headers);
    }
    
    // Get yesterday's date
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    
    // Get all data from source sheet
    const data = sourceSheet.getDataRange().getValues();
    const headers = data[0];
    const dateColumnIndex = 5; // Timestamp column index (0-based)
    
    // Filter yesterday's transactions
    const yesterdayTransactions = data.slice(1).filter(row => {
      const rowDate = new Date(row[dateColumnIndex]);
      rowDate.setHours(0, 0, 0, 0);
      return rowDate.getTime() === yesterday.getTime();
    });
    
    if (yesterdayTransactions.length === 0) {
      Logger.log('No transactions found for yesterday');
      return;
    }
    
    // Append transactions to archive sheet
    archiveSheet.getRange(
      archiveSheet.getLastRow() + 1,
      1,
      yesterdayTransactions.length,
      yesterdayTransactions[0].length
    ).setValues(yesterdayTransactions);
    
    // Remove transferred transactions from source sheet
    const newData = [headers];
    data.slice(1).forEach(row => {
      const rowDate = new Date(row[dateColumnIndex]);
      rowDate.setHours(0, 0, 0, 0);
      if (rowDate.getTime() !== yesterday.getTime()) {
        newData.push(row);
      }
    });
    
    // Clear and update source sheet
    sourceSheet.clearContents();
    sourceSheet.getRange(1, 1, newData.length, newData[0].length)
      .setValues(newData);
    
    // Clear relevant caches
    CacheManager.removeAll(['todayTransactions', 'salesOverview'], '1.0');
    
    Logger.log(`Successfully transferred ${yesterdayTransactions.length} transactions`);
    
  } catch (error) {
    Logger.log('Error in transferDailyTransactions:', error);
    throw error;
  }
}

// Optional: Function to manually test the transfer
function testTransferDailyTransactions() {
  transferDailyTransactions();
}

// Get allowed users from configuration sheet
function getAllowedUsers() {
  try {
    const CACHE_VERSION = '1.0';
    const cached = CacheManager.get('allowedUsers', CACHE_VERSION);
    
    if (cached) {
      return cached;
    }
    
    const sheet = SheetManager.getSheet('Config');
    const users = sheet.getRange('A2:A')
      .getValues()
      .flat()
      .filter(email => email && email.includes('@'));
    
    CacheManager.put('allowedUsers', users, CacheManager.DURATION.LONG, CACHE_VERSION);
    return users;
    
  } catch (error) {
    Logger.log('Error getting allowed users:', error);
    throw new Error('Failed to load allowed users configuration.');
  }
}

// Initialize the web app with access control
function doGet(e) {
  const userEmail = Session.getActiveUser().getEmail();
  const allowedUsers = getAllowedUsers();
  
  if (!allowedUsers.includes(userEmail)) {
    return HtmlService.createHtmlOutput('Access denied. Contact administrator.');
  }
  
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Salon Transaction Management System')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

// Efficient sheet access with caching
const SheetManager = {
  cache: {},
  
  getSheet(sheetName) {
    const now = Date.now();
    if (!this.cache[sheetName] || 
        now - this.cache[sheetName].timestamp > CacheManager.DURATION.LONG * 1000) {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        throw new Error(`Sheet "${sheetName}" not found`);
      }
      this.cache[sheetName] = {
        sheet: sheet,
        timestamp: now
      };
    }
    return this.cache[sheetName].sheet;
  }
};

// Get services with optimized caching
function getServices() {
  try {
    const CACHE_VERSION = '1.0';
    const cached = CacheManager.get('services', CACHE_VERSION);
    
    if (cached) {
      return cached;
    }
    
    const sheet = SheetManager.getSheet('Services');
    const services = sheet.getDataRange()
      .getValues()
      .slice(1)
      .map(row => ({
        name: row[0],
        price: row[1]
      }))
      .filter(service => service.name && !isNaN(service.price));
    
    CacheManager.put('services', services, CacheManager.DURATION.LONG, CACHE_VERSION);
    return services;
    
  } catch (error) {
    Logger.log('Error getting services:', error);
    throw new Error('Failed to load services. Please try again.');
  }
}

// Get staff with optimized caching
function getStaff() {
  try {
    const CACHE_VERSION = '1.0';
    const cached = CacheManager.get('staff', CACHE_VERSION);
    
    if (cached) {
      return cached;
    }
    
    const sheet = SheetManager.getSheet('Staff');
    const staff = sheet.getDataRange()
      .getValues()
      .slice(1)
      .map(row => row[0])
      .filter(name => name.length > 0);
    
    CacheManager.put('staff', staff, CacheManager.DURATION.LONG, CACHE_VERSION);
    return staff;
    
  } catch (error) {
    Logger.log('Error getting staff:', error);
    throw new Error('Failed to load staff list. Please try again.');
  }
}

// Generate unique transaction ID
function generateTransactionId() {
  const maxRetries = 3;
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    const timestamp = new Date().getTime();
    const random = Math.floor(Math.random() * 1000);
    const transactionId = `TXN${timestamp}${random}`;
    
    const sheet = SheetManager.getSheet('Transactions');
    const existingIds = sheet.getRange('A:A').getValues().flat();
    
    if (!existingIds.includes(transactionId)) {
      return transactionId;
    }
    
    retryCount++;
  }
  
  throw new Error('Failed to generate unique transaction ID');
}

// Save transaction with batch operations
function saveTransaction(transactionData) {
  try {
    if (!['Cash', 'GCash'].includes(transactionData.paymentMethod)) {
      throw new Error('Invalid payment method');
    }

    const sheet = SheetManager.getSheet('Transactions');
    const transactionId = generateTransactionId();
    const timestamp = new Date();
    
    const rows = transactionData.services.map(service => [
      transactionId,
      transactionData.customerName,
      service.serviceName,
      parseFloat(service.price),
      service.staff,
      timestamp,
      transactionData.paymentMethod,
      transactionData.remarks || ''
    ]);
    
    sheet.getRange(
      sheet.getLastRow() + 1,
      1,
      rows.length,
      8
    ).setValues(rows);
    
    // Clear relevant caches
    CacheManager.removeAll(['todayTransactions', 'salesOverview'], '1.0');
    
    return { success: true, transactionId };
    
  } catch (error) {
    Logger.log('Error saving transaction:', error);
    return {
      success: false,
      error: 'Failed to save transaction: ' + error.message
    };
  }
}

// Delete transaction with batch operations
function deleteTransaction(transactionId) {
  try {
    const sheet = SheetManager.getSheet('Transactions');
    const dataRange = sheet.getDataRange();
    const data = dataRange.getValues();
    
    const newData = data.filter(row => row[0] !== transactionId);
    
    if (newData.length === data.length) {
      throw new Error('Transaction not found');
    }
    
    sheet.clearContents();
    if (newData.length > 0) {
      sheet.getRange(1, 1, newData.length, newData[0].length)
        .setValues(newData);
    }
    
    CacheManager.removeAll(['todayTransactions', 'salesOverview'], '1.0');
    return { success: true };
    
  } catch (error) {
    Logger.log('Error deleting transaction:', error);
    return {
      success: false,
      error: 'Failed to delete transaction: ' + error.message
    };
  }
}

// Update transaction with batch operations
function updateTransaction(transactionId, transactionData) {
  try {
    if (!['Cash', 'GCash'].includes(transactionData.paymentMethod)) {
      throw new Error('Invalid payment method');
    }
    
    const sheet = SheetManager.getSheet('Transactions');
    const dataRange = sheet.getDataRange();
    const existingData = dataRange.getValues();
    
    const filteredData = existingData.filter(row => row[0] !== transactionId);
    
    const timestamp = new Date();
    const newRows = transactionData.services.map(service => [
      transactionId,
      transactionData.customerName,
      service.serviceName,
      parseFloat(service.price),
      service.staff,
      timestamp,
      transactionData.paymentMethod,
      transactionData.remarks || ''
    ]);
    
    const updatedData = [...filteredData, ...newRows];
    
    sheet.clearContents();
    sheet.getRange(1, 1, updatedData.length, updatedData[0].length)
      .setValues(updatedData);
    
    CacheManager.removeAll(['todayTransactions', 'salesOverview'], '1.0');
    return { success: true };
    
  } catch (error) {
    Logger.log('Error updating transaction:', error);
    return {
      success: false,
      error: 'Failed to update transaction: ' + error.message
    };
  }
}

// Get today's transactions with optimized caching
function getTodayTransactions() {
  try {
    const cacheKey = `todayTransactions_${new Date().toISOString().split('T')[0]}`;
    const CACHE_VERSION = '1.0';
    const cached = CacheManager.get(cacheKey, CACHE_VERSION);
    
    if (cached) {
      return cached;
    }
    
    const sheet = SheetManager.getSheet('Transactions');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const data = sheet.getDataRange().getValues();
    const transactions = data.slice(1);
    
    const groupedTransactions = transactions.reduce((acc, row) => {
      const [
        transactionId,
        customerName,
        serviceName,
        price,
        staffName,
        timestamp,
        paymentMethod,
        remarks
      ] = row;
      
      if (!timestamp || !transactionId) return acc;
      
      const transactionDate = new Date(timestamp);
      if (isNaN(transactionDate.getTime()) || 
          transactionDate.getTime() < today.getTime()) {
        return acc;
      }
      
      if (!acc[transactionId]) {
        acc[transactionId] = {
          transactionId: String(transactionId),
          customerName: String(customerName || ''),
          services: [],
          paymentMethod: String(paymentMethod || ''),
          remarks: String(remarks || ''),
          timestamp: transactionDate.toISOString(),
          total: 0
        };
      }
      
      const servicePrice = typeof price === 'number' ? 
        price : parseFloat(price) || 0;
      
      acc[transactionId].services.push({
        serviceName: String(serviceName || ''),
        price: servicePrice,
        staff: String(staffName || '')
      });
      acc[transactionId].total += servicePrice;
      
      return acc;
    }, {});
    
    const result = Object.values(groupedTransactions)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    CacheManager.put(cacheKey, result, CacheManager.DURATION.SHORT, CACHE_VERSION);
    return result;
    
  } catch (error) {
    Logger.log('Error getting today\'s transactions:', error);
    throw new Error('Failed to load transactions. Please try again.');
  }
}

// Get sales overview with optimized caching
function getSalesOverview() {
  try {
    const cacheKey = `salesOverview_${new Date().toISOString().split('T')[0]}`;
    const CACHE_VERSION = '1.0';
    const cached = CacheManager.get(cacheKey, CACHE_VERSION);
    
    if (cached) {
      return cached;
    }
    
    const transactions = getTodayTransactions();
    
    const overview = transactions.reduce((acc, transaction) => {
      transaction.services.forEach(service => {
        const amount = parseFloat(service.price) || 0;
        acc.total += amount;
        
        if (transaction.paymentMethod === 'Cash') {
          acc.cash += amount;
        } else if (transaction.paymentMethod === 'GCash') {
          acc.gcash += amount;
        }
      });
      return acc;
    }, {
      total: 0,
      cash: 0,
      gcash: 0
    });
    
    CacheManager.put(cacheKey, overview, CacheManager.DURATION.SHORT, CACHE_VERSION);
    return overview;
    
  } catch (error) {
    Logger.log('Error getting sales overview:', error);
    throw new Error('Failed to load sales overview. Please try again.');
  }
}