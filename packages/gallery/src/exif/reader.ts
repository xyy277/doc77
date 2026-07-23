import sharp from 'sharp';
import { validatePath } from '@doc77/core';

export interface ExifData {
  date: string | null;
  camera: string | null;
  lens: string | null;
  focal_length: string | null;
  aperture: string | null;
  shutter_speed: string | null;
  iso: number | null;
  gps: { latitude: number; longitude: number } | null;
  dimensions: { width: number; height: number };
  file_size: number;
}

/**
 * Read EXIF data from an image file.
 * Uses sharp for metadata extraction and exif-reader for parsing.
 */
export async function readExif(projectPath: string, relativePath: string): Promise<ExifData | null> {
  const absPath = validatePath(projectPath, relativePath);
  const fs = await import('node:fs');
  const stats = fs.statSync(absPath);

  try {
    const image = sharp(absPath);
    const metadata = await image.metadata();

    const data: ExifData = {
      date: null,
      camera: null,
      lens: null,
      focal_length: null,
      aperture: null,
      shutter_speed: null,
      iso: null,
      gps: null,
      dimensions: { width: metadata.width || 0, height: metadata.height || 0 },
      file_size: stats.size,
    };

    if (metadata.exif) {
      try {
        const exifReader = await import('exif-reader');
        const tags = exifReader.default(metadata.exif) as any;
        const exif = tags?.exif || {};
        const image_tags = tags?.image || {};

        if (exif.DateTimeOriginal) {
          data.date = new Date(exif.DateTimeOriginal).toISOString();
        }
        if (image_tags?.Make || image_tags?.Model) {
          data.camera = [image_tags?.Make, image_tags?.Model].filter(Boolean).join(' ');
        }
        if (exif.LensModel) {
          data.lens = exif.LensModel;
        }
        if (exif.FocalLength) data.focal_length = `${exif.FocalLength}mm`;
        if (exif.FNumber) data.aperture = `f/${exif.FNumber}`;
        if (exif.ExposureTime) {
          const denom = Math.round(1 / exif.ExposureTime);
          data.shutter_speed = `1/${denom}s`;
        }
        if (exif.ISO) data.iso = exif.ISO;

        // GPS
        const gps = tags?.gps || {};
        if (gps.GPSLatitude && gps.GPSLongitude) {
          data.gps = {
            latitude: gps.GPSLatitude,
            longitude: gps.GPSLongitude,
          };
        }
      } catch {
        // EXIF parse failed, return partial data
      }
    }

    return data;
  } catch {
    return null;
  }
}
