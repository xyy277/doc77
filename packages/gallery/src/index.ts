/**
 * @doc77/gallery — Doc77 媒体库
 *
 * 提供缩略图生成、画廊 API、相册管理和前端 UI。
 */
export { registerGalleryRoutes } from './routes/register.js';
export { getOrGenerateThumbnail } from './thumbnail/cache.js';
export { readExif } from './exif/reader.js';
export {
  listAlbums,
  createAlbum,
  updateAlbum,
  deleteAlbum,
  addAlbumItem,
  removeAlbumItem,
} from './album/store.js';
export type {
  GalleryOptions,
  GalleryEntry,
  GalleryListResponse,
  TimelineGroup,
  Album,
} from './types.js';
export type { ExifData } from './exif/reader.js';
