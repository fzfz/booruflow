export const MEDIA_CUTOVER_VERSION = 5;
export const MEDIA_CUTOVER_NAME = '005-media-cutover';
export const MEDIA_CUTOVER_PLAN_TABLE = 'media_cutover_paths';

export const CREATE_MEDIA_CUTOVER_PLAN_TABLE_SQL = `
  CREATE TABLE ${MEDIA_CUTOVER_PLAN_TABLE}(
    image_id INTEGER PRIMARY KEY,
    source_path TEXT NOT NULL UNIQUE,
    target_path TEXT NOT NULL UNIQUE
  );
`;
