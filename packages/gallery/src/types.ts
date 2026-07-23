/** Thumbnail size presets */
export type ThumbnailSize = 'grid' | 'preview';

/** Media type classification */
export type MediaType = 'image' | 'video';

/** Gallery entry returned by list API */
export interface GalleryEntry {
  name: string;
  path: string;
  type: MediaType;
  extension: string;
  size: number;
  modified: string;
  thumbnail_url: string;
  preview_url: string;
  raw_url: string;
  width: number | null;
  height: number | null;
  exif_date: string | null;
  duration: number | null;
}

/** Gallery list response */
export interface GalleryListResponse {
  entries: GalleryEntry[];
  total: number;
  offset: number;
  limit: number;
}

/** Timeline group */
export interface TimelineGroup {
  label: string;
  count: number;
  start_date: string;
  end_date: string;
  cover: { thumbnail_url: string; preview_url: string };
}

/** Album */
export interface Album {
  id: number;
  name: string;
  description: string;
  cover_source_hash: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** Options passed to registerGalleryRoutes */
export interface GalleryOptions {
  thumbnailsDir: string;
}
