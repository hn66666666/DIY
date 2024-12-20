const express = require('express');
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const dotenv = require('dotenv');
const path = require('path');
const exifParser = require('exif-parser');
const fs = require('fs');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const s3Client = new S3Client({
  region: 'us-east-1',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME;
const IMAGE_BASE_URL = process.env.R2_IMAGE_BASE_URL;
const IMAGE_DIR = process.env.R2_IMAGE_DIR;
const IMAGE_COMPRESSION_QUALITY = parseInt(process.env.IMAGE_COMPRESSION_QUALITY, 10);

const validImageExtensions = ['.jpg', '.jpeg', '.png', '.gif'];

async function checkAndCreateThumbnail(key) {
  const thumbnailKey = `${IMAGE_DIR}/preview/${path.basename(key)}`;
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: thumbnailKey }));
    return thumbnailKey;
  } catch (error) {
    if (error.name === 'NotFound') {
      const imageBuffer = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key })).then(response => {
        return new Promise((resolve, reject) => {
          const chunks = [];
          response.Body.on('data', (chunk) => chunks.push(chunk));
          response.Body.on('end', () => resolve(Buffer.concat(chunks)));
          response.Body.on('error', reject);
        });
      });

      const sharpInstance = sharp(imageBuffer).resize(200).withMetadata();

      if (IMAGE_COMPRESSION_QUALITY >= 0 && IMAGE_COMPRESSION_QUALITY <= 100) {
        sharpInstance.jpeg({ quality: IMAGE_COMPRESSION_QUALITY });
      }

      const thumbnailBuffer = await sharpInstance.toBuffer();

      const uploadParams = {
        Bucket: BUCKET_NAME,
        Key: thumbnailKey,
        Body: thumbnailBuffer,
        ContentType: 'image/jpeg',
      };

      await s3Client.send(new PutObjectCommand(uploadParams));

      return thumbnailKey;
    }
    throw error;
  }
}

async function getExifData(key) {
  const getObjectParams = {
    Bucket: BUCKET_NAME,
    Key: key,
  };
  const imageBuffer = await s3Client.send(new GetObjectCommand(getObjectParams)).then(response => {
    return new Promise((resolve, reject) => {
      const chunks = [];
      response.Body.on('data', (chunk) => chunks.push(chunk));
      response.Body.on('end', () => resolve(Buffer.concat(chunks)));
      response.Body.on('error', reject);
    });
  });
  const parser = exifParser.create(imageBuffer);
  const exifData = parser.parse().tags;
  return {
    FNumber: exifData.FNumber,
    ExposureTime: exifData.ExposureTime,
    ISO: exifData.ISO,
  };
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static('public', {
  index: false,
  maxAge: '1h'
}));

app.get('/images', async (req, res) => {
  try {
    console.log('Attempting to list objects from R2...');
    console.log('Using bucket:', BUCKET_NAME);
    console.log('Using prefix:', IMAGE_DIR);
    
    const images = await s3Client.send(new ListObjectsCommand({ 
      Bucket: BUCKET_NAME, 
      Prefix: IMAGE_DIR 
    }));
    
    if (!images.Contents) {
      console.log('No images found in bucket');
      return res.json([]);
    }

    console.log(`Found ${images.Contents.length} objects`);
    
    const imageUrls = await Promise.all(images.Contents.map(async (item) => {
      const itemExtension = path.extname(item.Key).toLowerCase();
      const isFile = item.Key.split('/').length === 2;
      if (!validImageExtensions.includes(itemExtension) || !isFile) {
        return null;
      }
      const thumbnailKey = await checkAndCreateThumbnail(item.Key);
      return {
        original: `${IMAGE_BASE_URL}/${item.Key}`,
        thumbnail: `${IMAGE_BASE_URL}/${thumbnailKey}`,
      };
    }));
    
    const filteredUrls = imageUrls.filter(url => url !== null);
    console.log(`Returning ${filteredUrls.length} image URLs`);
    res.json(filteredUrls);
  } catch (error) {
    console.error('Error loading images:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      requestId: error.$metadata?.requestId,
      cfRay: error.$metadata?.cfRay
    });
    res.status(500).json({
      error: 'Error loading images',
      details: error.message,
      code: error.code
    });
  }
});

app.get('/exif/:key', async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  try {
    const exifData = await getExifData(key);
    res.json(exifData);
  } catch (error) {
    console.error('Error getting EXIF data:', error);
    res.status(500).send('Error getting EXIF data');
  }
});

app.get('/config', (req, res) => {
  res.json({ IMAGE_BASE_URL: process.env.R2_IMAGE_BASE_URL });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});

app.use('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
