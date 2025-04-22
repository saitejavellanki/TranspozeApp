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

const app = express();
const port = process.env.PORT || 5514;
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Service account credentials
const CREDENTIALS = {
  client_email: 'vedya-736@transpozenew.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDKiHbyBxiEPbi6\niofE9XqYe/aqVl0rSPWpffLB0PT7TUTCHQuozpoH1q/aHGl8YHnYypqDv+MmZGCh\nhcLoLbe+5rxRLOVuPI0IkzxddkvK01ZmRZNrhyPMt3O2eiSN2n+F3PRCODWQ6tSl\nG9xtju42DipO/wDa482xELpeg0rm09/HEgli+iS+10q2W+3ab575KS/aQFAHN3XI\nvJCFl94be6PLqBIUZooBdn44dCN8oBlYguiqIV0EttMzKetF5UbwOSltKwi0vAPF\n+jpdVUnUKfpugLXe51/N5I3CqbWvGQiL8kxdDIVo1yu+O8ddVfELbWH45hHWOY4B\nSi/2TTDbAgMBAAECggEAOG9FIZSrlrGyJzyRr2atlg64wWcWSAjo9yUSv0Hv+ZRi\ny+oXBR8omXWPg6m2FQO3ABsYagzOiTSgHnHsyRBwKmAV6lKlzY1OySxpvitH3Ej+\nQroxZV1/MryNoDOxuts+/HiAkXEjL/HXdfho+BhDNUnGLUPuI5AlkSi1nb9c4Ct7\nwhHj+eFgf4qtO8DvlPGPPp6JQ8kyxUrolrqUvZrM6R5FRJFbsHXNvcQE7inDFQE4\nEpxvRS79xDi8Km4P6rFECaDSpGd4tCcc6t9N78ql2uIjVdX2W4zR01LLqiWBm2xp\nolw2QPcENWVAu4KCctr5VLwSv7gNK5QnKepNTfhSLQKBgQDkBPMpngH/5uMV+XUV\nNCY7iQIToV4XHpYSOvT5W+V22bYFk951yh0IgzqTiNYfIF01xhZSmPXa5jbOVuvP\nt8SJKccx3yq6t0T2zCRCxjSkSCwNFYjgwCMYGHKhAZu/k49bBBLUw2XZkxiR8135\nBk/akuzALjm0AmmueQKXBk7oZwKBgQDjYuIm7IDz6bS7rK/YxTlB5zcrjdKa1eRg\n1RGUtP+v/k4Y7LdjyK24wqQXy5FMe28xi6yTWlJ5PELvRsQ353c0X6uHy6c6q7fm\nSroQ3U2jHwaUng3uGBWageWl8nl+hCTgZnnRJfdRTeXvX0GswqcC4kRRPnLLOCxi\nogvY4ue7bQKBgHDnrowF7FGNPxaLbhkwuFm0bq3PsmpaP88JGHI8ubOO+91pKbdD\ne/rSF/gjwnqpKN5OlpERonNgmPS0/5DcGtocMMEWEu9ffiuCS9YwlLJf9kgISL2Z\nBgeRW3kz9a333/0eWEC3/D+u4XSrf/Wl1XaSV96VRQdIRpIY41pqyjmzAoGADRc7\nR9xjzCcPRaK6ePNZyYaDMZm3nzxjKoP5wCLveXVdj6fJIxCBl9p00f3hPpL4otSU\nueMAToR+ogHj+Af2X+iGGopJ9WG/c52nuqLS/moh2dqDmMqAK+YAj543CmaXLOgZ\naUYTR/YBH9fPEyAdt1fJcRf0SejQ/Viw7+qYRr0CgYBcux8wMr9A6e5KpuAqZW89\nYuurZ52dH4S1S4u5gKaJ1R6UsdjBV8GA6y0iAOvll4lfa5lo5OjNJNK/76jOOVcC\neu6oTApICSDPJ2ILuqiWKLFqUDLlEV5Dp1RggRGTKv0odejGiQQMx1d6QN+xPfif\nO3yrcnpNhlZE3FeZhVf+rw==\n-----END PRIVATE KEY-----\n',
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

// Helper function to convert audio file to PCM format
async function convertAudioToPCM(inputFile, outputFile) {
  try {
    // Convert to PCM 16-bit, 16kHz, mono
    const command = `ffmpeg -i ${inputFile} -acodec pcm_s16le -ac 1 -ar 16000 ${outputFile}`;
    await execPromise(command);
    console.log(`Successfully converted audio to PCM: ${outputFile}`);
    return true;
  } catch (error) {
    console.error('Audio conversion failed:', error);
    throw new Error(`Audio conversion failed: ${error.message}`);
  }
}
// Cache for folder IDs
const folderCache = {};

// Routes for folder operations
app.post('/api/folders/find', async (req, res) => {
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

    const response = await drive.files.list({
      q: query,
      fields: 'files(id, name)',
      spaces: 'drive'
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

app.post('/api/folders/create', async (req, res) => {
  try {
    const { folderName, parentId } = req.body;
    
    const drive = initDriveClient();
    
    const fileMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      fields: 'id'
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
        fields: 'files(id)'
      });
      
      health.googleDriveConnection = 'connected';
      health.googleDriveApiStatus = 'ok';
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
    // Use 500 only if you want monitoring systems to detect a server issue
    return res.status(200).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Helper functions to replace internal fetch calls
async function findFolder(folderName, parentId) {
  // Check cache
  const cacheKey = parentId ? `${parentId}_${folderName}` : folderName;
  if (folderCache[cacheKey]) {
    return { id: folderCache[cacheKey] };
  }
  
  const drive = initDriveClient();
  
  // Build the query
  let query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
  if (parentId) {
    query += ` and '${parentId}' in parents`;
  }

  const response = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    spaces: 'drive'
  });

  if (response.data.files && response.data.files.length > 0) {
    const folderId = response.data.files[0].id;
    folderCache[cacheKey] = folderId;
    return { id: folderId };
  }
  
  return { id: null };
}

async function createFolder(folderName, parentId) {
  const drive = initDriveClient();
  
  const fileMetadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: parentId ? [parentId] : undefined
  };

  const response = await drive.files.create({
    requestBody: fileMetadata,
    fields: 'id'
  });

  if (response.data.id) {
    const cacheKey = parentId ? `${parentId}_${folderName}` : folderName;
    folderCache[cacheKey] = response.data.id;
    return { id: response.data.id };
  } else {
    throw new Error('Folder creation failed - no ID returned');
  }
}

async function ensureFolder(folderName, parentId) {
  // First try to find the folder
  let findResult = await findFolder(folderName, parentId);
  
  if (findResult.id) {
    return { id: findResult.id };
  }
  
  // If not found, create it
  let createResult = await createFolder(folderName, parentId);
  return { id: createResult.id };
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
    fields: 'id'
  });
  
  if (response.data.id) {
    return { id: response.data.id };
  } else {
    throw new Error('File upload failed - no ID returned');
  }
}

app.post('/api/folders/ensure', async (req, res) => {
  try {
    const { folderName, parentId } = req.body;
    const result = await ensureFolder(folderName, parentId);
    return res.json(result);
  } catch (error) {
    console.error('Failed to ensure folder exists:', error);
    res.status(500).json({ error: `Failed to ensure folder exists: ${error.message}` });
  }
});

// Route for file upload
app.post('/api/files/upload', upload.single('file'), async (req, res) => {
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
app.post('/api/folders/hierarchy', async (req, res) => {
  try {
    const { schoolName, classLevel, subject } = req.body;
    const result = await createFolderHierarchy(schoolName, classLevel, subject);
    return res.json(result);
  } catch (error) {
    console.error('Failed to create folder hierarchy:', error);
    res.status(500).json({ error: `Failed to create folder hierarchy: ${error.message}` });
  }
});

// Route to save a recording directly
// Route to save a recording with conversion to PCM
app.post('/api/recordings/save', upload.single('file'), async (req, res) => {
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
      spaces: 'drive'
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
      q: `mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`,
      fields: 'files(id, name, modifiedTime)',
      spaces: 'drive'
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

// Route to get file info
app.get('/api/files/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const drive = initDriveClient();
    
    const response = await drive.files.get({
      fileId: fileId,
      fields: 'id, name, mimeType, size, modifiedTime, webViewLink, webContentLink, parents'
    });
    
    return res.json(response.data);
  } catch (error) {
    console.error('Failed to get file info:', error);
    res.status(500).json({ error: `Failed to get file info: ${error.message}` });
  }
});

// Route to share a file with a specific user
app.post('/api/files/:fileId/share', async (req, res) => {
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
      sendNotificationEmail: false
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
      fields: 'id'
    });
    
    // Get the file information with the links
    const file = await drive.files.get({
      fileId: fileId,
      fields: 'webViewLink, webContentLink'
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
      spaces: 'drive'
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

// Route to copy a file to user's personal Google Drive
app.post('/api/files/:fileId/copy', async (req, res) => {
  try {
    const { fileId } = req.params;
    const { targetEmail, newName } = req.body;
    
    if (!targetEmail) {
      return res.status(400).json({ error: 'Target email is required' });
    }
    
    const drive = initDriveClient();
    
    // First share the file with the user
    const permission = {
      type: 'user',
      role: 'writer', // Need write access to copy
      emailAddress: targetEmail
    };
    
    await drive.permissions.create({
      fileId: fileId,
      requestBody: permission,
      fields: 'id'
    });
    
    // Get the file's metadata
    const fileResponse = await drive.files.get({
      fileId: fileId,
      fields: 'name, mimeType'
    });
    
    // Create a copy
    const copyRequestBody = {
      name: newName || `Copy of ${fileResponse.data.name}`
    };
    
    const copyResponse = await drive.files.copy({
      fileId: fileId,
      requestBody: copyRequestBody,
      fields: 'id, name, webViewLink'
    });
    
    return res.json({
      success: true,
      originalFileId: fileId,
      copiedFileId: copyResponse.data.id,
      name: copyResponse.data.name,
      webViewLink: copyResponse.data.webViewLink,
      message: `File successfully copied to ${targetEmail}'s Google Drive`
    });
  } catch (error) {
    console.error('Failed to copy file:', error);
    res.status(500).json({ error: `Failed to copy file: ${error.message}` });
  }
});

// Route to share service account folders with personal account
app.post('/api/folders/shareWithPersonal', async (req, res) => {
  try {
    const { email, role = 'reader' } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email address is required' });
    }
    
    const drive = initDriveClient();
    
    // Get all root folders
    const foldersResponse = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive'
    });
    
    const folders = foldersResponse.data.files;
    const shareResults = [];
    
    // Share each folder with the user
    for (const folder of folders) {
      try {
        // Create permission
        const permission = {
          type: 'user',
          role: role,
          emailAddress: email
        };
        
        const response = await drive.permissions.create({
          fileId: folder.id,
          requestBody: permission,
          fields: 'id',
          sendNotificationEmail: false
        });
        
        shareResults.push({
          folder: folder.name,
          success: true,
          permissionId: response.data.id
        });
      } catch (folderError) {
        console.error(`Failed to share folder ${folder.name}:`, folderError);
        shareResults.push({
          folder: folder.name,
          success: false,
          error: folderError.message
        });
      }
    }
    
    return res.json({
      success: true,
      message: `Shared ${shareResults.filter(r => r.success).length} of ${folders.length} folders with ${email}`,
      results: shareResults
    });
  } catch (error) {
    console.error('Failed to share folders with personal account:', error);
    res.status(500).json({ error: `Failed to share folders: ${error.message}` });
  }
});

// Add this route to your existing server.js file

// Route to delete all folders and clear the space
app.delete('/api/folders/deleteAll', async (req, res) => {
  try {
    const { confirm } = req.body;
    
    // Require confirmation to prevent accidental deletion
    if (confirm !== 'DELETE_ALL_FOLDERS') {
      return res.status(400).json({ 
        error: 'Confirmation required', 
        message: 'Please include {"confirm": "DELETE_ALL_FOLDERS"} in the request body to confirm deletion of all folders'
      });
    }
    
    const drive = initDriveClient();
    
    // Get all root folders
    const response = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive'
    });
    
    const folders = response.data.files;
    const deletionResults = [];
    
    // Delete each folder
    for (const folder of folders) {
      try {
        await drive.files.delete({
          fileId: folder.id
        });
        
        deletionResults.push({
          folder: folder.name,
          success: true
        });
      } catch (folderError) {
        console.error(`Failed to delete folder ${folder.name}:`, folderError);
        deletionResults.push({
          folder: folder.name,
          success: false,
          error: folderError.message
        });
      }
    }
    
    // Clear the folder cache
    Object.keys(folderCache).forEach(key => {
      delete folderCache[key];
    });
    
    return res.json({
      success: true,
      message: `Successfully deleted ${deletionResults.filter(r => r.success).length} of ${folders.length} folders`,
      results: deletionResults
    });
  } catch (error) {
    console.error('Failed to delete all folders:', error);
    res.status(500).json({ error: `Failed to delete all folders: ${error.message}` });
  }
});

// Route to delete a specific folder and all its contents
app.delete('/api/folders/:folderId', async (req, res) => {
  try {
    const { folderId } = req.params;
    
    // Validate folder ID
    if (!folderId) {
      return res.status(400).json({ error: 'Folder ID is required' });
    }
    
    const drive = initDriveClient();
    
    // Delete the folder
    await drive.files.delete({
      fileId: folderId
    });
    
    // Remove any matching entries from folder cache
    Object.keys(folderCache).forEach(key => {
      if (folderCache[key] === folderId) {
        delete folderCache[key];
      }
    });
    
    return res.json({
      success: true,
      message: `Folder ${folderId} successfully deleted`
    });
  } catch (error) {
    console.error(`Failed to delete folder ${req.params.folderId}:`, error);
    res.status(500).json({ error: `Failed to delete folder: ${error.message}` });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Google Drive API server running on port ${port}`);
});