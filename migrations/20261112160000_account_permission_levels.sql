-- 权限模型调整（SID#2.1.LAW）：
--   - 『控制台·完全』改为管理员特有，普通账号已存的 admin_access:full 降为 readonly；
--   - content_manage 与 content_private 合并为 content_access 一项两级：
--     content_manage:full -> content_access:full（包含机密可读）
--     content_private:read -> content_access:private_read
--
-- 可重复执行：已是新格式的行原样保留。无法识别的权限项丢弃（应用读取时本来也会忽略）；
-- 结果为空或原值不是数组时置 NULL。管理员的 permissions 恒为 NULL，不受影响。
UPDATE users
SET permissions = CASE
  WHEN JSON_TYPE(permissions) = 'ARRAY' AND (
    JSON_CONTAINS(permissions, JSON_OBJECT('field', 'admin_access', 'level', 'readonly'))
    OR JSON_CONTAINS(permissions, JSON_OBJECT('field', 'admin_access', 'level', 'full'))
    OR JSON_CONTAINS(permissions, JSON_OBJECT('field', 'content_access', 'level', 'full'))
    OR JSON_CONTAINS(permissions, JSON_OBJECT('field', 'content_access', 'level', 'private_read'))
    OR JSON_CONTAINS(permissions, JSON_OBJECT('field', 'content_manage', 'level', 'full'))
    OR JSON_CONTAINS(permissions, JSON_OBJECT('field', 'content_private', 'level', 'read'))
  ) THEN JSON_MERGE_PRESERVE(
    IF(
      JSON_CONTAINS(permissions, JSON_OBJECT('field', 'admin_access', 'level', 'readonly'))
      OR JSON_CONTAINS(permissions, JSON_OBJECT('field', 'admin_access', 'level', 'full')),
      JSON_ARRAY(JSON_OBJECT('field', 'admin_access', 'level', 'readonly')),
      JSON_ARRAY()
    ),
    CASE
      WHEN JSON_CONTAINS(permissions, JSON_OBJECT('field', 'content_access', 'level', 'full'))
        OR JSON_CONTAINS(permissions, JSON_OBJECT('field', 'content_manage', 'level', 'full'))
        THEN JSON_ARRAY(JSON_OBJECT('field', 'content_access', 'level', 'full'))
      WHEN JSON_CONTAINS(permissions, JSON_OBJECT('field', 'content_access', 'level', 'private_read'))
        OR JSON_CONTAINS(permissions, JSON_OBJECT('field', 'content_private', 'level', 'read'))
        THEN JSON_ARRAY(JSON_OBJECT('field', 'content_access', 'level', 'private_read'))
      ELSE JSON_ARRAY()
    END
  )
  ELSE NULL
END
WHERE permissions IS NOT NULL;
