import type { ContentMarkdownConfig } from './content-markdown'
import { describe, expect, it } from 'vitest'
import {
  attachment_base_name,
  attachment_download_name,
  attachment_name_segment_violation,
  attachment_path_violation,
  compare_attachment_names,
  decrypted_attachment_name,
  extract_attachment_names,
  extract_story_reference_titles,
  folder_file_count,
  folder_images,
  is_attachment_folder,
  is_encrypted_attachment,
  link_file_name_byte_length,
  lowercased_attachment_extension,
  normalized_attachment_extension,
  parse_story_markdown,
  redactable_attachment_mime,
  rename_attachment_references,
  rename_story_references,
  sanitize_attachment_file_name,
  sanitize_attachment_path,
  sanitize_attachment_segment,
  split_attachment_editable_name,
} from './content-markdown'

const config: ContentMarkdownConfig = {
  title_max_length: 120,
  label_max_bytes: 500,
  desc_max_bytes: 500,
  cover_max_bytes: 500,
  markdown_max_bytes: 100000,
  existing_titles: [
    { id: 1, title: '蠢猪，从何而来？' },
    { id: 3, title: '另一档案' },
  ],
}

function story_doc(body: string, title = '测试档案') {
  return `---\ntitle: ${title}\ntime: 2026/8/8\n---\n\n${body}`
}

describe('compare_attachment_names', () => {
  function sorted(names: string[]) {
    return [... names].sort(compare_attachment_names)
  }

  it('orders numbered names numerically, not character by character', () => {
    // A plain string comparison settles on the leading digit ('1' < '2'), so
    // this is what the `numeric` option exists for: without it the order is
    // 1, 10, 11, 2, 3 rather than 1, 2, 3, 10, 11.
    expect(sorted(['11.png', '2.png', '1.png', '10.png', '3.png']))
      .toEqual(['1.png', '2.png', '3.png', '10.png', '11.png'])
  })

  it('compares the number itself, so 9 sorts before 10', () => {
    expect(compare_attachment_names('9.png', '10.png')).toBeLessThan(0)
    expect(compare_attachment_names('10.png', '9.png')).toBeGreaterThan(0)
  })

  it('orders numbered folders the same way', () => {
    expect(sorted(['cards10', 'cards1', 'cards2'])).toEqual(['cards1', 'cards2', 'cards10'])
  })

  it('handles numbers embedded after Chinese text', () => {
    expect(sorted(['纯粹gif02.gif', '纯粹gif10.gif', '纯粹gif01.gif']))
      .toEqual(['纯粹gif01.gif', '纯粹gif02.gif', '纯粹gif10.gif'])
  })

  it('handles Chinese names without falling back to code-point order', () => {
    // The exact order is ICU-dependent, so it is not pinned here; what is
    // asserted is that the names come back complete, distinct and stable, and
    // that equal inputs compare equal.
    const chinese = ['桌子', '椅子', 'aaa', 'zzz']
    const ordered = sorted(chinese)

    expect(ordered).toHaveLength(chinese.length)
    expect(new Set(ordered)).toEqual(new Set(chinese))
    expect(sorted(ordered)).toEqual(ordered)
    expect(compare_attachment_names('桌子', '桌子')).toBe(0)
  })

  it('compares full paths, so a folder groups before its own children', () => {
    expect(sorted(['b/2.png', 'b/10.png', 'a/1.png']))
      .toEqual(['a/1.png', 'b/2.png', 'b/10.png'])
  })

  it('is symmetric and stable for equal names', () => {
    expect(compare_attachment_names('a/x.png', 'a/x.png')).toBe(0)
    expect(Math.sign(compare_attachment_names('1.png', '2.png')))
      .toBe(- Math.sign(compare_attachment_names('2.png', '1.png')))
  })
})

describe('attachment folder helpers', () => {
  const with_images = (names: string[]) => names.map(name => ({
    file_name: name,
    is_image: /\.(?:png|jpe?g|gif|webp)$/i.test(name),
  }))

  const scope = with_images([
    'cards/1.png',
    'cards/10.png',
    'cards/2.png',
    'cards/notes.txt',
    'cards/sub/9.png',
    '其他/x.png',
    'solo.png',
  ])

  describe('is_attachment_folder', () => {
    it('recognises a folder by the files living under it', () => {
      expect(is_attachment_folder(scope, 'cards')).toBe(true)
      expect(is_attachment_folder(scope, 'cards/sub')).toBe(true)
      expect(is_attachment_folder(scope, '其他')).toBe(true)
    })

    it('tolerates a trailing slash', () => {
      expect(is_attachment_folder(scope, 'cards/')).toBe(true)
      expect(is_attachment_folder(scope, 'cards//')).toBe(true)
    })

    it('rejects a path nothing lives under', () => {
      expect(is_attachment_folder(scope, 'nope')).toBe(false)
      expect(is_attachment_folder(scope, 'card')).toBe(false)
    })

    it('rejects a real file, even one whose name is a folder prefix of others', () => {
      // `cards` as a file and `cards/…` as a folder can coexist; the file wins,
      // so an image reference stays an image.
      const both = [... scope, ... with_images(['cards'])]

      expect(is_attachment_folder(both, 'cards')).toBe(false)
      expect(is_attachment_folder(scope, 'solo.png')).toBe(false)
    })

    it('rejects an empty path', () => {
      expect(is_attachment_folder(scope, '')).toBe(false)
      expect(is_attachment_folder(scope, '/')).toBe(false)
    })
  })

  describe('folder_images', () => {
    it('returns the folder images in natural order', () => {
      expect(folder_images(scope, 'cards')?.map(item => item.file_name))
        .toEqual(['cards/1.png', 'cards/2.png', 'cards/10.png'])
    })

    it('skips files that are not images', () => {
      expect(folder_images(scope, 'cards')?.map(item => item.file_name))
        .not.toContain('cards/notes.txt')
    })

    it('takes direct children only', () => {
      expect(folder_images(scope, 'cards')?.map(item => item.file_name))
        .not.toContain('cards/sub/9.png')
      expect(folder_images(scope, 'cards/sub')?.map(item => item.file_name))
        .toEqual(['cards/sub/9.png'])
    })

    it('is empty for a folder holding no images', () => {
      expect(folder_images(with_images(['docs/readme.md']), 'docs')).toEqual([])
    })

    it('is null when the path is not a folder', () => {
      expect(folder_images(scope, 'nope')).toBeNull()
      expect(folder_images(scope, 'solo.png')).toBeNull()
      expect(folder_images(scope, '')).toBeNull()
    })

    it('leaves the caller\'s list untouched', () => {
      const original = scope.map(item => item.file_name)

      folder_images(scope, 'cards')

      expect(scope.map(item => item.file_name)).toEqual(original)
    })
  })

  describe('folder_file_count', () => {
    it('counts every file below the folder, recursion included', () => {
      // 1.png, 2.png, 10.png, notes.txt and sub/9.png.
      expect(folder_file_count(scope, 'cards')).toBe(5)
    })

    it('counts a nested folder on its own', () => {
      expect(folder_file_count(scope, 'cards/sub')).toBe(1)
    })

    it('is zero for a path with nothing under it', () => {
      expect(folder_file_count(scope, 'nope')).toBe(0)
      expect(folder_file_count(scope, '')).toBe(0)
    })
  })
})

describe('extract_attachment_names', () => {
  it('extracts link and image destinations', () => {
    expect(extract_attachment_names('[](a.zip) and ![](b.jpg)')).toEqual(['a.zip', 'b.jpg'])
  })

  it('catches both the nested link and the outer image destination', () => {
    // The regex this replaces consumed the nested link and orphaned the outer one.
    expect(extract_attachment_names('![关公面前耍大刀😇[](高二1班_蠢猪组.zip)](蠢猪组提交.jpg)').sort())
      .toEqual(['蠢猪组提交.jpg', '高二1班_蠢猪组.zip'].sort())
  })

  it('walks arbitrarily deep nesting inside labels', () => {
    expect(extract_attachment_names('![a [x [y](c.zip)](b.jpg)](a.png)').sort())
      .toEqual(['a.png', 'b.jpg', 'c.zip'].sort())
  })

  it('ignores story references, anchors and external URLs', () => {
    expect(extract_attachment_names('[](@档案标题) [](#anchor) [](https://example.com/x.jpg)')).toEqual([])
  })

  it('accepts (possibly nested) folder paths', () => {
    expect(extract_attachment_names('[](dir/a.jpg) [](dir/sub/b.jpg)').sort()).toEqual(['dir/a.jpg', 'dir/sub/b.jpg'].sort())
  })

  it('accepts angle destinations and title suffixes', () => {
    expect(extract_attachment_names('[](<a.jpg>) ![](b.jpg "标题")').sort()).toEqual(['a.jpg', 'b.jpg'].sort())
  })

  it('ignores link lookalikes inside inline code spans', () => {
    expect(extract_attachment_names('`[](a.jpg)` and `` `[](b.jpg)` ``')).toEqual([])
  })

  it('ignores link lookalikes inside fenced code blocks', () => {
    expect(extract_attachment_names('```md\n[](fenced.jpg)\n```\n\n[](real.jpg)')).toEqual(['real.jpg'])
  })

  it('ignores a `]` inside a code span within the label', () => {
    expect(extract_attachment_names('![a `]` b](x.jpg)')).toEqual(['x.jpg'])
  })

  it('ignores unterminated and unbalanced destinations', () => {
    expect(extract_attachment_names('[](a.jpg and [](b(c)')).toEqual([])
  })
})

describe('rename_attachment_references', () => {
  it('renames the destination and a default label, but keeps custom labels', () => {
    expect(rename_attachment_references('[a.jpg](a.jpg) [自定义](a.jpg)', 'a.jpg', 'b.jpg'))
      .toBe('[b.jpg](b.jpg) [自定义](b.jpg)')
  })

  it('renames a link nested inside an image label without breaking the outer image', () => {
    expect(rename_attachment_references('![关公面前耍大刀😇[](高二1班_蠢猪组.zip)](蠢猪组提交.jpg)', '高二1班_蠢猪组.zip', '新压缩包.zip'))
      .toBe('![关公面前耍大刀😇[](新压缩包.zip)](蠢猪组提交.jpg)')
  })

  it('renames the outer image destination without touching the nested link', () => {
    expect(rename_attachment_references('![关公面前耍大刀😇[](高二1班_蠢猪组.zip)](蠢猪组提交.jpg)', '蠢猪组提交.jpg', '新图.jpg'))
      .toBe('![关公面前耍大刀😇[](高二1班_蠢猪组.zip)](新图.jpg)')
  })

  it('preserves whitespace and title suffixes around the destination', () => {
    expect(rename_attachment_references('![](  a.jpg  "标题")', 'a.jpg', 'b.jpg'))
      .toBe('![](  b.jpg  "标题")')
  })

  it('leaves code spans and fenced blocks untouched', () => {
    expect(rename_attachment_references('`[](a.jpg)`\n\n```\n[](a.jpg)\n```\n\n[](a.jpg)', 'a.jpg', 'b.jpg'))
      .toBe('`[](a.jpg)`\n\n```\n[](a.jpg)\n```\n\n[](b.jpg)')
  })

  it('leaves unrelated links untouched', () => {
    expect(rename_attachment_references('[](other.jpg) [](@档案) text', 'a.jpg', 'b.jpg'))
      .toBe('[](other.jpg) [](@档案) text')
  })
})

describe('extract_story_reference_titles', () => {
  it('extracts link and image story references, deduplicated', () => {
    expect(extract_story_reference_titles('[](@蠢猪，从何而来？) ![图](@另一档案) [](@蠢猪，从何而来？)').sort())
      .toEqual(['另一档案', '蠢猪，从何而来？'].sort())
  })

  it('extracts references nested inside image labels', () => {
    expect(extract_story_reference_titles('![x[](@另一档案)](a.jpg)')).toEqual(['另一档案'])
  })

  it('ignores bare prose lookalikes and code spans', () => {
    expect(extract_story_reference_titles('正文 (@另一档案) 与 `[](@蠢猪，从何而来？)`')).toEqual([])
  })
})

describe('rename_story_references', () => {
  it('renames references and keeps labels and other text intact', () => {
    expect(rename_story_references('[](@旧标题) [文本](@旧标题) 正文 (@旧标题)', '旧标题', '新标题'))
      .toBe('[](@新标题) [文本](@新标题) 正文 (@旧标题)')
  })

  it('renames references nested inside image labels', () => {
    expect(rename_story_references('![x[](@旧标题)](a.jpg)', '旧标题', '新标题'))
      .toBe('![x[](@新标题)](a.jpg)')
  })
})

describe('encrypted attachment naming', () => {
  it('reads the .good suffix as the encryption marker', () => {
    expect(is_encrypted_attachment('photo.png.good')).toBe(true)
    expect(is_encrypted_attachment('photo.png')).toBe(false)
  })

  it('recovers the pre-encryption name, including the folder prefix', () => {
    expect(decrypted_attachment_name('cards/photo.png.good')).toBe('cards/photo.png')
    // A plaintext name is already its own answer.
    expect(decrypted_attachment_name('cards/photo.png')).toBe('cards/photo.png')
  })

  it('keeps a .good file whose stem already looks like one intact', () => {
    // Only the suffix comes off, so a name that itself ends in `good` survives.
    expect(decrypted_attachment_name('a.good.good')).toBe('a.good')
  })
})

describe('extension normalization', () => {
  it('lowercases the extension of a stored name', () => {
    expect(lowercased_attachment_extension('Photo.PNG')).toBe('Photo.png')
    expect(lowercased_attachment_extension('clip.Mp4')).toBe('clip.mp4')
    // Only the last segment counts: folder names are untouched.
    expect(lowercased_attachment_extension('Docs/report.PDF')).toBe('Docs/report.pdf')
  })

  it('passes names without an extension through unchanged', () => {
    expect(lowercased_attachment_extension('README')).toBe('README')
    // A leading dot is the name itself (the `.good` marker), not a separator.
    expect(lowercased_attachment_extension('.good')).toBe('.good')
  })

  it('sanitizes uploads to a lowercase extension', () => {
    expect(sanitize_attachment_file_name('IMG_2026.JPG', 255)).toBe('IMG_2026.jpg')
    expect(sanitize_attachment_file_name('照片.PNG', 255)).toBe('照片.png')
  })

  // A folder's dots are part of its name, not an extension, so only the final
  // segment of an upload path is normalized.
  it('leaves a folder segment exactly as uploaded', () => {
    expect(sanitize_attachment_segment('My.Folder', 255)).toBe('My.Folder')
    expect(sanitize_attachment_segment('v1.2.Docs', 255)).toBe('v1.2.Docs')
  })

  it('normalizes only the last segment of a nested upload path', () => {
    expect(sanitize_attachment_path('My.Folder/a.TXT', 255)).toBe('My.Folder/a.txt')
    expect(sanitize_attachment_path('v1.2.Docs/报告.PDF', 255)).toBe('v1.2.Docs/报告.pdf')
  })

  // Only the extension is case-mapped, and a non-ASCII one can grow when
  // lowercased (İ is 2 bytes, its lowercase is 3). Normalizing before the cap is
  // what keeps the stored name inside it. The broken order still passes the
  // ASCII cases, so this is the case that pins the sequence.
  it('holds the byte cap over the normalized name', () => {
    const result = sanitize_attachment_file_name('file.İ', 7)
    expect(link_file_name_byte_length(result)).toBeLessThanOrEqual(7)
  })
})

describe('normalized_attachment_extension', () => {
  // The marker is the last dot, so lowercasing the final suffix alone would
  // leave the plaintext extension behind it untouched.
  it('reaches the extension underneath a .good marker', () => {
    expect(normalized_attachment_extension('secret.PNG.good')).toBe('secret.png.good')
    // Already-normalized names are returned unchanged, marker and all.
    expect(normalized_attachment_extension('secret.png.good')).toBe('secret.png.good')
  })

  it('matches the plain rule for a name with no marker', () => {
    expect(normalized_attachment_extension('Photo.PNG')).toBe('Photo.png')
    expect(normalized_attachment_extension('README')).toBe('README')
  })

  it('normalizes a .good name supplied at a boundary', () => {
    // An upload arrives through the sanitizer, which has to normalize the real
    // extension even when the name carries the marker.
    expect(sanitize_attachment_file_name('a.PNG.good', 255)).toBe('a.png.good')
  })
})

describe('attachment_download_name', () => {
  it('saves under the base name, marker stripped and extension lowercased', () => {
    expect(attachment_download_name('docs/report.PDF')).toBe('report.pdf')
    expect(attachment_download_name('a/b/secret.PNG.good')).toBe('secret.png')
    expect(attachment_download_name('裸名.txt')).toBe('裸名.txt')
  })
})

describe('attachment name rules', () => {
  // The single source of truth every operation's guard is built on: upload,
  // rename, replace, folder create/rename/move. A rule that only held in one of
  // them is exactly the bug this consolidates away.
  describe('attachment_name_segment_violation', () => {
    it('accepts ordinary names', () => {
      expect(attachment_name_segment_violation('photo.png')).toBeNull()
      expect(attachment_name_segment_violation('蠢猪组提交.jpg')).toBeNull()
      expect(attachment_name_segment_violation('photo-1_final.png')).toBeNull()
    })

    it('reserves the .good suffix, whichever kind of entry asks', () => {
      // Encrypting is the only thing allowed to append it, and a hand-made one
      // would occupy the very name a real decrypt (or 删减版) needs.
      expect(attachment_name_segment_violation('photo.png.good')).toContain('.good')
      expect(attachment_name_segment_violation('cards.good')).toContain('.good')
    })

    it('rejects illegal characters', () => {
      expect(attachment_name_segment_violation('a/b.png')).toContain('不支持的字符')
      expect(attachment_name_segment_violation('a:b.png')).toContain('不支持的字符')
      expect(attachment_name_segment_violation('a?b.png')).toContain('不支持的字符')
      // Whitespace and parens are in the rejected set too — uploads are
      // sanitized into names without them, so a rename must not introduce one.
      expect(attachment_name_segment_violation('a b.png')).toContain('不支持的字符')
      expect(attachment_name_segment_violation('photo (1).png')).toContain('不支持的字符')
    })

    it('rejects a leading or trailing dot', () => {
      expect(attachment_name_segment_violation('.hidden')).toContain('点号')
      expect(attachment_name_segment_violation('name.')).toContain('点号')
    })

    it('rejects the Windows device names', () => {
      expect(attachment_name_segment_violation('con')).toContain('系统保留名')
      expect(attachment_name_segment_violation('COM1.txt')).toContain('系统保留名')
      expect(attachment_name_segment_violation('console.txt')).toBeNull()
    })

    it('rejects an empty name', () => {
      expect(attachment_name_segment_violation('')).toContain('不能为空')
    })
  })

  describe('attachment_path_violation', () => {
    it('accepts a nested path whose every level is legal', () => {
      expect(attachment_path_violation('cards/sub/photo.png')).toBeNull()
    })

    it('reports the offending level, not the whole path', () => {
      expect(attachment_path_violation('cards/bad.good/photo.png')).toContain('.good')
      expect(attachment_path_violation('cards/sub/bad:name.png')).toContain('不支持的字符')
    })

    it('catches a suffix on the file itself', () => {
      expect(attachment_path_violation('cards/photo.png.good')).toContain('.good')
    })
  })
})

describe('split_attachment_editable_name', () => {
  // The rename prompt locks this tail and edits the rest, and the server judges
  // legality on the rest, so both sides have to agree on where the split is.
  it('locks the extension and the marker together', () => {
    expect(split_attachment_editable_name('photo.png.good'))
      .toEqual({ editable: 'photo', locked: '.png.good' })
  })

  it('locks only the marker when the plaintext name has no extension', () => {
    expect(split_attachment_editable_name('plain_file.good'))
      .toEqual({ editable: 'plain_file', locked: '.good' })
  })

  it('locks the extension of a plaintext file', () => {
    expect(split_attachment_editable_name('photo.png'))
      .toEqual({ editable: 'photo', locked: '.png' })
  })

  it('splits the base name, not the folder, so a dotted folder stays intact', () => {
    expect(split_attachment_editable_name('my.dir/photo.png.good'))
      .toEqual({ editable: 'photo', locked: '.png.good' })
    // The dotted folder must not be mistaken for an extension.
    expect(split_attachment_editable_name('my.dir/photo'))
      .toEqual({ editable: 'photo', locked: '' })
  })

  it('keeps dots that are part of the editable name', () => {
    expect(split_attachment_editable_name('my.archive.tar.gz'))
      .toEqual({ editable: 'my.archive.tar', locked: '.gz' })
  })

  it('leaves a name with no extension entirely editable', () => {
    expect(split_attachment_editable_name('README')).toEqual({ editable: 'README', locked: '' })
  })

  it('recomposes the original name', () => {
    for (const name of ['photo.png.good', 'plain_file.good', 'photo.png', 'a/b.tar.gz', 'README']) {
      const { editable, locked } = split_attachment_editable_name(name)
      expect(`${editable}${locked}`).toBe(attachment_base_name(name))
    }
  })
})

describe('redactable_attachment_mime', () => {
  it('accepts the formats the canvas can read and write back', () => {
    expect(redactable_attachment_mime('photo.png.good')).toBe('image/png')
    expect(redactable_attachment_mime('photo.jpg.good')).toBe('image/jpeg')
    expect(redactable_attachment_mime('photo.jpeg.good')).toBe('image/jpeg')
    expect(redactable_attachment_mime('photo.webp.good')).toBe('image/webp')
    expect(redactable_attachment_mime('photo.bmp.good')).toBe('image/bmp')
  })

  it('reads the format from the name without the .good suffix', () => {
    // The suffix is appended to the original extension, so the mime lives before it.
    expect(redactable_attachment_mime('photo.png.good')).toBe(redactable_attachment_mime('photo.png'))
  })

  it('rejects animated and non-canvas formats rather than transcoding them', () => {
    expect(redactable_attachment_mime('anim.gif.good')).toBeNull()
    expect(redactable_attachment_mime('photo.avif.good')).toBeNull()
    expect(redactable_attachment_mime('drawing.svg.good')).toBeNull()
  })

  it('rejects names with no known extension', () => {
    expect(redactable_attachment_mime('photo')).toBeNull()
    expect(redactable_attachment_mime('photo.png.good.bak')).toBeNull()
  })
})

describe('parse_story_markdown at-story lint', () => {
  it('flags dead references with the body line number', () => {
    const { issues } = parse_story_markdown(story_doc('前言\n\n[](@不存在档案)'), config)
    expect(issues).toEqual([{ line: 8, severity: 'error', source: 'at-story', message: '档案『不存在档案』不可引用' }])
  })

  it('flags self references', () => {
    const { issues } = parse_story_markdown(story_doc('[](@测试档案)'), config)
    expect(issues).toEqual([{ line: 6, severity: 'error', source: 'at-story', message: '不允许自我引用' }])
  })

  it('accepts references to existing stories, including nested ones', () => {
    const { issues } = parse_story_markdown(story_doc('[](@蠢猪，从何而来？)\n![x[](@另一档案)](a.jpg)'), config)
    expect(issues.filter(issue => issue.source === 'at-story')).toEqual([])
  })

  it('ignores bare prose lookalikes and code spans', () => {
    const { issues } = parse_story_markdown(story_doc('正文 (@不存在档案) 与 `[](@也不存在)`'), config)
    expect(issues.filter(issue => issue.source === 'at-story')).toEqual([])
  })
})
