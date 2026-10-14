export {FILE_OBSERVATION_ALGORITHM,fileObservation,validFileObservation} from '../platform/file-observation.js';
export const FILE_STABLE_MS=750;
export const fileObservationSchema=`
 CREATE TABLE media_file_observation(file_id TEXT PRIMARY KEY REFERENCES media_file(id) ON DELETE CASCADE,algorithm TEXT NOT NULL,stamp TEXT NOT NULL CHECK(length(stamp)=64));
 ALTER TABLE scan_entry ADD COLUMN observation_hash TEXT CHECK(observation_hash IS NULL OR length(observation_hash)=64);
 ALTER TABLE scan_entry ADD COLUMN observed_at INTEGER CHECK(observed_at IS NULL OR observed_at>=0);
`;
