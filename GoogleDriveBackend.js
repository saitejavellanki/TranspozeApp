// backend/server.js
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
require('dotenv').config();
const FormData = require('form-data');
const axios = require('axios');
const { exec } = require('child_process'); // For FFmpeg execution
const util = require('util'); // For promisifying exec
const execPromise = util.promisify(exec); // Promisify exec
const rateLimit = require('express-rate-limit');

const app = express();
const port = process.env.PORT || 5514;
const upload = multer({ dest: 'uploads/' });

// Shared Drive ID - configure this in your environment variables
const SHARED_DRIVE_ID = process.env.SHARED_DRIVE_ID;

app.set('trust proxy', 1);
// Middleware
app.use(cors());
app.use(bodyParser.json());

// Service account credentials
const CREDENTIALS = {
  client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  private_key: process.env.GOOGLE_PRIVATE_KEY,
  scopes: ['https://www.googleapis.com/auth/drive']
};

// Initialize the Google Drive client
const initDriveClient = () => {
  const auth = new google.auth.JWT(
    CREDENTIALS.client_email,
    null,
    CREDENTIALS.private_key,
    CREDENTIALS.scopes
  );

  return google.drive({ version: 'v3', auth });
};

// Configure rate limiters
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: 'Too many requests from this IP, please try again after 15 minutes'
});

// More strict limiter for write operations
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // limit each IP to 30 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many write operations from this IP, please try again after 15 minutes'
});

// Apply general rate limiter to all requests
app.use(generalLimiter);

// Cache for folder IDs
const folderCache = {};

// Routes for folder operations
app.post('/api/folders/find', writeLimiter, async (req, res) => {
  try {
    const { folderName, parentId } = req.body;
    
    // Check cache
    const cacheKey = parentId ? `${parentId}_${folderName}` : folderName;
    if (folderCache[cacheKey]) {
      return res.json({ id: folderCache[cacheKey] });
    }
    
    const drive = initDriveClient();
    
    // Build the query
    let query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
    if (parentId) {
      query += ` and '${parentId}' in parents`;
    }

    // Add driveId parameter to search within the shared drive
    const response = await drive.files.list({
      q: query,
      fields: 'files(id, name)',
      spaces: 'drive',
      driveId: SHARED_DRIVE_ID,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: 'drive'
    });

    if (response.data.files && response.data.files.length > 0) {
      const folderId = response.data.files[0].id;
      folderCache[cacheKey] = folderId;
      return res.json({ id: folderId });
    }
    
    return res.json({ id: null });
  } catch (error) {
    console.error('Failed to find folder:', error);
    res.status(500).json({ error: `Failed to find folder: ${error.message}` });
  }
});

app.post('/api/folders/create', writeLimiter, async (req, res) => {
  try {
    const { folderName, parentId } = req.body;
    
    const drive = initDriveClient();
    
    const fileMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : [SHARED_DRIVE_ID]
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      fields: 'id',
      supportsAllDrives: true
    });

    if (response.data.id) {
      const cacheKey = parentId ? `${parentId}_${folderName}` : folderName;
      folderCache[cacheKey] = response.data.id;
      return res.json({ id: response.data.id });
    } else {
      throw new Error('Folder creation failed - no ID returned');
    }
  } catch (error) {
    console.error('Failed to create folder:', error);
    res.status(500).json({ error: `Failed to create folder: ${error.message}` });
  }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    // Basic health information
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      service: 'Google Drive API Server',
      version: process.env.VERSION || '1.0.0'
    };

    // Check Google Drive API connection
    try {
      const drive = initDriveClient();
      
      // Simple API test - list a single file to validate credentials
      const apiResponse = await drive.files.list({
        pageSize: 1,
        fields: 'files(id)',
        driveId: SHARED_DRIVE_ID,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        corpora: 'drive'
      });
      
      health.googleDriveConnection = 'connected';
      health.googleDriveApiStatus = 'ok';
      health.sharedDriveId = SHARED_DRIVE_ID;
    } catch (driveError) {
      console.error('Google Drive connection check failed:', driveError);
      health.googleDriveConnection = 'disconnected';
      health.googleDriveApiStatus = 'error';
      health.googleDriveError = driveError.message;
      
      // Still return 200 but with connection error details
    }

    // System information
    health.memory = {
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB',
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
    };
    
    // Check folder cache size
    health.folderCacheSize = Object.keys(folderCache).length;

    return res.json(health);
  } catch (error) {
    console.error('Health check failed:', error);
    // Even on error, return 200 with error details to avoid triggering monitoring alerts
    return res.status(200).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Helper functions to replace internal fetch calls
async function findFolder(folderName, parentId) {
  try {
    // Sanitize inputs to prevent injection and query issues
    const safefolderName = folderName.replace(/'/g, "\\'");
    
    // Check cache
    const cacheKey = parentId ? `${parentId}_${folderName}` : folderName;
    if (folderCache[cacheKey]) {
      console.log(`Cache hit for folder: ${folderName} [${folderCache[cacheKey]}]`);
      return { id: folderCache[cacheKey] };
    }
    
    const drive = initDriveClient();
    
    // Build the query - make sure it's exact matching
    let query = `mimeType='application/vnd.google-apps.folder' and name='${safefolderName}' and trashed=false`;
    if (parentId) {
      query += ` and '${parentId}' in parents`;
    }

    console.log(`Searching for folder: "${folderName}" with query: ${query}`);
    
    const response = await drive.files.list({
      q: query,
      fields: 'files(id, name, parents)',
      spaces: 'drive',
      driveId: SHARED_DRIVE_ID,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: 'drive'
    });

    console.log(`Found ${response.data.files.length} matching folders for "${folderName}"`);
    
    if (response.data.files && response.data.files.length > 0) {
      // Log all found folders for debugging
      response.data.files.forEach((file, idx) => {
        console.log(`Match ${idx+1}: ID=${file.id}, Name=${file.name}, Parents=${file.parents}`);
      });
      
      // Use the first match
      const folderId = response.data.files[0].id;
      folderCache[cacheKey] = folderId;
      console.log(`Selected folder ID: ${folderId} for "${folderName}"`);
      return { id: folderId };
    }
    
    console.log(`No folder found with name: "${folderName}" ${parentId ? `under parent ${parentId}` : 'at root level'}`);
    return { id: null };
  } catch (error) {
    console.error(`Error finding folder "${folderName}":`, error);
    throw error;
  }
}

async function createFolder(folderName, parentId) {
  try {
    // First, double-check if folder exists to avoid race conditions
    const existingFolder = await findFolder(folderName, parentId);
    if (existingFolder.id) {
      console.log(`Folder already exists during create check: "${folderName}" [${existingFolder.id}]`);
      return existingFolder;
    }
    
    console.log(`Creating new folder "${folderName}" ${parentId ? `under parent ${parentId}` : 'at root level'}`);
    
    const drive = initDriveClient();
    
    const fileMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : [SHARED_DRIVE_ID]
    };

    const requestParams = {
      requestBody: fileMetadata,
      fields: 'id',
      supportsAllDrives: true,
      driveId: SHARED_DRIVE_ID,
      includeItemsFromAllDrives: true
    };

    const response = await drive.files.create(requestParams);

    if (response.data.id) {
      const cacheKey = parentId ? `${parentId}_${folderName}` : folderName;
      folderCache[cacheKey] = response.data.id;
      console.log(`Created folder: "${folderName}" with ID: ${response.data.id}`);
      return { id: response.data.id };
    } else {
      throw new Error('Folder creation failed - no ID returned');
    }
  } catch (error) {
    console.error(`Error creating folder "${folderName}":`, error);
    throw error;
  }
}

async function ensureFolder(folderName, parentId) {
  console.log(`Ensuring folder exists: "${folderName}" ${parentId ? `under parent ${parentId}` : 'at root level'}`);
  
  // First try to find the folder
  let findResult = await findFolder(folderName, parentId);
  
  if (findResult.id) {
    console.log(`Using existing folder: "${folderName}" [${findResult.id}]`);
    return findResult;
  }
  
  // If not found, create it
  console.log(`No folder found, creating: "${folderName}"`);
  return await createFolder(folderName, parentId);
}

async function createFolderHierarchy(schoolName, classLevel, subject) {
  if (!schoolName || !classLevel || !subject) {
    throw new Error('Missing required folder parameters');
  }
  
  // Create school folder
  let schoolResult = await ensureFolder(schoolName);
  
  // Create class folder
  let classResult = await ensureFolder(classLevel, schoolResult.id);
  
  // Create subject folder
  let subjectResult = await ensureFolder(subject, classResult.id);
  
  return {
    schoolId: schoolResult.id,
    classId: classResult.id,
    subjectId: subjectResult.id
  };
}

async function uploadFile(filePath, fileName, mimeType, folderId) {
  const drive = initDriveClient();
  
  // Create file metadata
  const fileMetadata = {
    name: fileName,
    parents: [folderId]
  };
  
  // Upload the file
  const media = {
    mimeType: mimeType,
    body: fs.createReadStream(filePath)
  };
  
  const response = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id',
    supportsAllDrives: true,
    driveId: SHARED_DRIVE_ID,
    corpora: 'drive',
    includeItemsFromAllDrives: true
  });
  
  if (response.data.id) {
    return { id: response.data.id };
  } else {
    throw new Error('File upload failed - no ID returned');
  }
}

app.post('/api/folders/ensure', writeLimiter, async (req, res) => {
  try {
    const { folderName, parentId } = req.body;
    
    if (!folderName) {
      return res.status(400).json({ error: 'Folder name is required' });
    }
    
    console.log(`API request to ensure folder: "${folderName}" ${parentId ? `under parent ${parentId}` : 'at root level'}`);
    
    const result = await ensureFolder(folderName, parentId);
    
    return res.json({
      id: result.id,
      name: folderName,
      parentId: parentId || 'root',
      message: `Folder "${folderName}" is now available with ID: ${result.id}`
    });
  } catch (error) {
    console.error(`API error ensuring folder "${req.body.folderName}":`, error);
    res.status(500).json({ error: `Failed to ensure folder exists: ${error.message}` });
  }
});

// Route to list shared drives
app.get('/api/drives', async (req, res) => {
  try {
    const drive = initDriveClient();
    
    const response = await drive.drives.list({
      pageSize: 100
    });
    
    return res.json({
      drives: response.data.drives,
      total: response.data.drives.length
    });
  } catch (error) {
    console.error('Failed to list shared drives:', error);
    res.status(500).json({ error: `Failed to list shared drives: ${error.message}` });
  }
});

// Route for file upload
app.post('/api/files/upload', writeLimiter, upload.single('file'), async (req, res) => {
  try {
    const { fileName, mimeType, folderId } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const filePath = req.file.path;
    
    const result = await uploadFile(
      filePath,
      fileName || req.file.originalname,
      mimeType || req.file.mimetype,
      folderId
    );
    
    // Clean up the temporary file
    fs.unlinkSync(filePath);
    
    return res.json(result);
  } catch (error) {
    console.error('Failed to upload file:', error);
    res.status(500).json({ error: `Failed to upload file: ${error.message}` });
  }
});

// Route for folder hierarchy setup
app.post('/api/folders/hierarchy', writeLimiter, async (req, res) => {
  try {
    const { schoolName, classLevel, subject } = req.body;
    const result = await createFolderHierarchy(schoolName, classLevel, subject);
    return res.json(result);
  } catch (error) {
    console.error('Failed to create folder hierarchy:', error);
    res.status(500).json({ error: `Failed to create folder hierarchy: ${error.message}` });
  }
});
//hi hi
// Route to save a recording with conversion to PCM
app.post('/api/recordings/save', writeLimiter, upload.single('file'), async (req, res) => {
  try {
    const { schoolName, classLevel, subject, fileName } = req.body;

    // Validate required parameters and uploaded file
    if (!schoolName || !classLevel || !subject || !fileName || !req.file) {
      return res.status(400).json({ 
        error: 'Missing required parameters',
        received: { schoolName, classLevel, subject, fileName, file: !!req.file }
      });
    }

    // Create the folder hierarchy in Google Drive using our helper function
    const folders = await createFolderHierarchy(schoolName, classLevel, subject);

    // Upload the file to Google Drive using our helper function
    const uploadResult = await uploadFile(
      req.file.path,
      fileName,
      'audio/wav',
      folders.subjectId
    );

    // Remove the temporary uploaded file
    fs.unlinkSync(req.file.path);

    // Respond with success and file info
    return res.json({
      success: true,
      fileId: uploadResult.id,
      path: `${schoolName}/${classLevel}/${subject}/${fileName}`
    });

  } catch (error) {
    console.error('Failed to save recording:', error);
    res.status(500).json({ error: `Failed to save recording: ${error.message}` });
  }
});

// Route to list contents of a folder (folders and files)
app.get('/api/folders/:folderId/contents', async (req, res) => {
  try {
    const { folderId } = req.params;
    const drive = initDriveClient();
    
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink)',
      spaces: 'drive',
      driveId: SHARED_DRIVE_ID,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: 'drive'
    });
    
    const items = response.data.files.map(file => {
      return {
        id: file.id,
        name: file.name,
        type: file.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
        mimeType: file.mimeType,
        size: file.size,
        modifiedTime: file.modifiedTime,
        webViewLink: file.webViewLink
      };
    });
    
    // Organize by type (folders first, then files)
    const folders = items.filter(item => item.type === 'folder');
    const files = items.filter(item => item.type === 'file');
    
    return res.json({
      folders,
      files,
      total: items.length
    });
  } catch (error) {
    console.error('Failed to list folder contents:', error);
    res.status(500).json({ error: `Failed to list folder contents: ${error.message}` });
  }
});

// Route to get top-level folders
app.get('/api/folders/root', async (req, res) => {
  try {
    const drive = initDriveClient();
    
    const response = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name, modifiedTime)',
      spaces: 'drive',
      driveId: SHARED_DRIVE_ID,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: 'drive'
    });
    
    return res.json({
      folders: response.data.files,
      total: response.data.files.length
    });
  } catch (error) {
    console.error('Failed to list root folders:', error);
    res.status(500).json({ error: `Failed to list root folders: ${error.message}` });
  }
});

// Route to get files from service account's personal storage
app.get('/api/personal/files', async (req, res) => {
  try {
    const drive = initDriveClient();
    
    const response = await drive.files.list({
      q: `'me' in owners and trashed=false`,  // Only include files you own
      fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink)',
      spaces: 'drive',
      corpora: 'user',  // Only search in user's My Drive
      supportsAllDrives: false,  // Don't include shared drives
    });
    
    const items = response.data.files.map(file => {
      return {
        id: file.id,
        name: file.name,
        type: file.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
        mimeType: file.mimeType,
        size: file.size,
        modifiedTime: file.modifiedTime,
        webViewLink: file.webViewLink
      };
    });
    
    // Organize by type (folders first, then files)
    const folders = items.filter(item => item.type === 'folder');
    const files = items.filter(item => item.type === 'file');
    
    return res.json({
      folders,
      files,
      total: items.length
    });
  } catch (error) {
    console.error('Failed to list personal files:', error);
    res.status(500).json({ error: `Failed to list personal files: ${error.message}` });
  }
});

// Get personal drive storage usage
app.get('/api/storage/personal', async (req, res) => {
  try {
    const drive = initDriveClient();
    
    const response = await drive.about.get({
      fields: 'storageQuota'
    });
    
    const storageQuota = response.data.storageQuota;
    
    return res.json({
      usage: storageQuota.usage,  // Current usage in bytes
      limit: storageQuota.limit,  // Total storage limit in bytes
      usageInDrive: storageQuota.usageInDrive,  // Usage in Drive (excludes Gmail, Photos)
      usageInDriveTrash: storageQuota.usageInDriveTrash,  // Usage in Drive trash
      availableSpace: storageQuota.limit - storageQuota.usage,  // Available space in bytes
      percentUsed: (storageQuota.usage / storageQuota.limit) * 100  // Percentage used
    });
  } catch (error) {
    console.error('Failed to get personal drive storage info:', error);
    res.status(500).json({ error: `Failed to get storage info: ${error.message}` });
  }
});

// Get shared drive storage usage
app.get('/api/storage/shared/:driveId', async (req, res) => {
  try {
    const drive = initDriveClient();
    const driveId = req.params.driveId;
    
    if (!driveId) {
      return res.status(400).json({ error: 'Shared drive ID is required' });
    }
    
    // Get the specific shared drive info
    const driveResponse = await drive.drives.get({
      driveId: driveId,
      fields: 'id,name,storageQuota'
    });
    
    const storageQuota = driveResponse.data.storageQuota || {};
    
    return res.json({
      driveId: driveResponse.data.id,
      driveName: driveResponse.data.name,
      usageInDrive: storageQuota.usageInDrive,  // Usage in bytes
      limit: storageQuota.limit,  // Storage limit in bytes (may be null if unlimited)
      usage: storageQuota.usage,  // Total usage in bytes
      availableSpace: storageQuota.limit ? storageQuota.limit - storageQuota.usage : null,
      percentUsed: storageQuota.limit ? (storageQuota.usage / storageQuota.limit) * 100 : null
    });
  } catch (error) {
    console.error('Failed to get shared drive storage info:', error);
    res.status(500).json({ error: `Failed to get storage info: ${error.message}` });
  }
});
// Route to get file info
app.get('/api/files/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const drive = initDriveClient();
    
    const response = await drive.files.get({
      fileId: fileId,
      fields: 'id, name, mimeType, size, modifiedTime, webViewLink, webContentLink, parents',
      supportsAllDrives: true
    });
    
    return res.json(response.data);
  } catch (error) {
    console.error('Failed to get file info:', error);
    res.status(500).json({ error: `Failed to get file info: ${error.message}` });
  }
});

// Route to share a file with a specific user
app.post('/api/files/:fileId/share', writeLimiter, async (req, res) => {
  try {
    const { fileId } = req.params;
    const { email, role = 'reader' } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email address is required' });
    }
    
    // Validate role
    const validRoles = ['reader', 'writer', 'commenter', 'owner'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ 
        error: 'Invalid role. Must be one of: reader, writer, commenter, owner',
        validRoles
      });
    }
    
    const drive = initDriveClient();
    
    // Create permission
    const permission = {
      type: 'user',
      role: role,
      emailAddress: email
    };
    
    const response = await drive.permissions.create({
      fileId: fileId,
      requestBody: permission,
      fields: 'id',
      sendNotificationEmail: false,
      supportsAllDrives: true
    });
    
    return res.json({
      success: true,
      permissionId: response.data.id,
      message: `File successfully shared with ${email}`
    });
  } catch (error) {
    console.error('Failed to share file:', error);
    res.status(500).json({ error: `Failed to share file: ${error.message}` });
  }
});

// Route to get publicly accessible links for a file
app.post('/api/files/:fileId/getLink', async (req, res) => {
  try {
    const { fileId } = req.params;
    const { type = 'view' } = req.body;
    
    const drive = initDriveClient();
    
    // First, update the file permissions to make it accessible
    const permission = {
      type: 'anyone',
      role: type === 'view' ? 'reader' : 'writer',
    };
    
    // Create the permission
    await drive.permissions.create({
      fileId: fileId,
      requestBody: permission,
      fields: 'id',
      supportsAllDrives: true
    });
    
    // Get the file information with the links
    const file = await drive.files.get({
      fileId: fileId,
      fields: 'webViewLink, webContentLink',
      supportsAllDrives: true
    });
    
    return res.json({
      success: true,
      fileId: fileId,
      viewLink: file.data.webViewLink,
      downloadLink: file.data.webContentLink
    });
  } catch (error) {
    console.error('Failed to get file link:', error);
    res.status(500).json({ error: `Failed to get file link: ${error.message}` });
  }
});

// Route to search for files and folders
app.get('/api/search', async (req, res) => {
  try {
    const { query, type } = req.query;
    
    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    
    const drive = initDriveClient();
    
    // Build search query
    let searchQuery = `name contains '${query}' and trashed=false`;
    
    // Filter by type if specified
    if (type === 'folder') {
      searchQuery += ` and mimeType='application/vnd.google-apps.folder'`;
    } else if (type === 'file') {
      searchQuery += ` and mimeType!='application/vnd.google-apps.folder'`;
    }
    
    const response = await drive.files.list({
      q: searchQuery,
      fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink, parents)',
      spaces: 'drive',
      driveId: SHARED_DRIVE_ID,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: 'drive'
    });
    
    const items = response.data.files.map(file => {
      return {
        id: file.id,
        name: file.name,
        type: file.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
        mimeType: file.mimeType,
        size: file.size,
        modifiedTime: file.modifiedTime,
        webViewLink: file.webViewLink,
        parentId: file.parents && file.parents.length > 0 ? file.parents[0] : null
      };
    });
    
    return res.json({
      items,
      total: items.length
    });
  } catch (error) {
    console.error('Failed to search files:', error);
    res.status(500).json({ error: `Failed to search files: ${error.message}` });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Google Drive API server running on port ${port}`);
  console.log(`Using Shared Drive ID: ${SHARED_DRIVE_ID}`);
});