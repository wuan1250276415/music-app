export const tagCommitReconcileSchema=`
 ALTER TABLE tag_commit_reprobe ADD COLUMN mode TEXT NOT NULL DEFAULT 'native-verified' CHECK(mode IN('native-verified','interrupted-target'));
 CREATE TRIGGER tag_commit_reprobe_mode_identity BEFORE UPDATE OF mode ON tag_commit_reprobe BEGIN SELECT RAISE(ABORT,'恢复核对模式不可修改'); END;
 CREATE TRIGGER tag_commit_reprobe_mode_owner BEFORE INSERT ON tag_commit_reprobe WHEN
  (NEW.mode='native-verified' AND NOT EXISTS(SELECT 1 FROM tag_commit_operation WHERE id=NEW.operation_id AND state='native_verified' AND final_json IS NOT NULL AND exit_confirmed=1)) OR
  (NEW.mode='interrupted-target' AND NOT EXISTS(SELECT 1 FROM tag_commit_operation WHERE id=NEW.operation_id AND state='recovery_required'))
  BEGIN SELECT RAISE(ABORT,'恢复核对模式与原提交历史不符'); END;
`;
