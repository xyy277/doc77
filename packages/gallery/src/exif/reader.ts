import sharp from 'sharp';
import { validatePath } from '@doc77/core';
import fs from 'node:fs';

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

// exif-reader 返回的类型结构（该包无内置类型定义）
interface ExifTags {
  exif?: {
    DateTimeOriginal?: Date;
    LensModel?: string;
    FocalLength?: number;
    FNumber?: number;
    ExposureTime?: number;
    ISO?: number;
  };
  gps?: {
    GPSLatitude?: number[];
    GPSLongitude?: number[];
    GPSLatitudeRef?: string;
    GPSLongitudeRef?: string;
  };
  image?: {
    Make?: string;
    Model?: string;
  };
}

/**
 * 将 DMS（degrees, minutes, seconds）数组转换为十进制坐标。
 * @param dms [degrees, minutes, seconds] 数组
 * @param ref 方向参考：'S' 或 'W' 返回负值，其余返回正值
 */
function dmsToDecimal(dms: number[], ref?: string): number {
  const [degrees, minutes, seconds] = dms;
  const decimal = degrees + minutes / 60 + seconds / 3600;
  return ref === 'S' || ref === 'W' ? -decimal : decimal;
}

/**
 * Read EXIF data from an image file.
 * Uses sharp for metadata extraction and exif-reader for parsing.
 */
export async function readExif(
  projectPath: string,
  relativePath: string,
): Promise<ExifData | null> {
  const absPath = validatePath(projectPath, relativePath);

  try {
    const stats = fs.statSync(absPath);
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
        const tags = exifReader.default(metadata.exif) as ExifTags;
        const exif = tags?.exif || {};
        const imageTags = tags?.image || {};

        if (exif.DateTimeOriginal) {
          data.date = exif.DateTimeOriginal.toISOString();
        }
        if (imageTags?.Make || imageTags?.Model) {
          data.camera = [imageTags?.Make, imageTags?.Model].filter(Boolean).join(' ');
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

        // GPS — DMS 数组转十进制坐标
        const gps = tags?.gps || {};
        if (gps.GPSLatitude && gps.GPSLongitude) {
          data.gps = {
            latitude: dmsToDecimal(gps.GPSLatitude, gps.GPSLatitudeRef),
            longitude: dmsToDecimal(gps.GPSLongitude, gps.GPSLongitudeRef),
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
