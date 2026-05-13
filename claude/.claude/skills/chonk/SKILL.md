---
name: chonk
description: Upload files with the chonk command and return shareable chonk URLs. Use when the user asks to upload files to chonk or share files via chonk.
---

# Chonk

Use the `chonk` command to upload one or more files concurrently:

```bash
chonk file1 file2 ... fileN
```

It prints one line per file:

```text
<file name>: https://chonk.us1.prod.dog/v2/get/chonk-uploads-prod/felixge/<uuid>
```

When the user asks to upload files, run `chonk` with the requested paths and report the resulting URLs.
