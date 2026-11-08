# 🖥️ Personal NAS Server (`nasproject`)

โปรเจกต์ระบบ **NAS (Network Attached Storage) Server** ที่พัฒนาขึ้นเอง สำหรับเปลี่ยน PC ให้เป็นเซิร์ฟเวอร์จัดเก็บไฟล์ส่วนตัว แชร์ไฟล์ภายในบ้าน ต่อเป็น Network Drive (WebDAV) และตรวจสอบสถานะฮาร์ดแวร์ผ่าน Web Dashboard

---

## 🏗️ สถาปัตยกรรมของระบบ (System Architecture)

1. **Client / Frontend Layer (หน้าบ้าน):**
   - Web Dashboard สำหรับจัดการไฟล์ (File Explorer แบบ Grid/List, Sorting, Multi-select, Move/Copy, Drag & Drop Chunked Upload พร้อมแสดง `%` ความเร็วและเวลาที่เหลือแบบสดๆ, Media Preview)
   - หน้าค้นหาทั่วระบบ & ตรวจจับไฟล์ซ้ำ (Global Search & Duplicate File Detector)
   - หน้าจัดการ Auto-Backup Snapshots และคู่มือเชื่อมต่อ WebDAV Network Drive
   - หน้า Public Share Portal (`/s/:token`) สำหรับผู้รับลิงก์ภายนอก (ไม่ต้องล็อกอิน NAS, รองรับการกรอกรหัสผ่านปลดล็อกลิงก์)
   - หน้าจัดการผู้ใช้ โควตาพื้นที่ และนโยบายนามสกุลไฟล์ (Admin User, Quota & Extension Policy)
   - หน้า Recycle Bin (ถังขยะพร้อมระบบกู้คืนไปยัง Path เดิม)
   - หน้า System Monitor แสดงสถานะ CPU, RAM, พื้นที่ Disk และ IP ในวง LAN แบบ Real-time
2. **API, WebDAV & Core Backend Layer (หลังบ้าน):**
   - ระบบ Authentication & Role-based Access (`admin` / `user`) พร้อมระบบ Home Directory Isolation (`storage/files/Users/{username}`)
   - **WebDAV Server (`src/webdav.js`):** รองรับโปรโตคอล RFC 4918 (`OPTIONS`, `PROPFIND`, `GET`, `PUT`, `MKCOL`, `DELETE`, `MOVE`, `COPY`, `LOCK`, `UNLOCK`) เพื่อเชื่อมต่อเป็น Network Drive บน macOS Finder และ Windows Explorer ได้ทันที
   - ระบบตรวจสอบโควตาพื้นที่รายบุคคล (`assertQuotaAvailable`) และนโยบายคัดกรองนามสกุลไฟล์ (`assertExtensionAllowed`)
   - ระบบจัดการไฟล์แบบ Stream และ **Chunked Resumable Upload** เพื่อรองรับไฟล์ขนาดใหญ่โดยไม่กิน RAM
   - ระบบบีบอัดไฟล์ `.zip` แบบ Stream on-the-fly (`src/zip.js`)
3. **Database, Indexer & Scheduler Layer:**
   - ใช้ **SQLite** (`node:sqlite` Built-in) เก็บข้อมูลผู้ใช้ (`users`), ถังขยะ (`trash_items`), สถานะอัปโหลด (`upload_sessions`), ลิงก์แชร์ (`share_links`), ดัชนีไฟล์ (`file_index`), และการตั้งค่าระบบ (`system_settings`)
   - **Fast File Indexer (`src/indexer.js`):** สแกนและทำดัชนีไฟล์ลง SQLite พร้อมระบบเปรียบเทียบ Hash (`SHA-256`) เพื่อตรวจจับไฟล์ซ้ำซ้อน
   - **Auto-Backup & Task Scheduler (`src/scheduler.js`):** สร้างไฟล์สำรองข้อมูล `.zip` อัตโนมัติลง `storage/backups/`, หมุนเวียนไฟล์สำรองตามจำนวนที่กำหนด, และลบไฟล์เก่าในถังขยะอัตโนมัติ
4. **Storage & OS Integration Layer:**
   - เชื่อมต่อกับ Filesystem จริง (`storage/files`, `storage/trash`, `storage/backups`, และ `storage/.cache`)
   - สร้างและแคชภาพย่ออัตโนมัติ (`src/thumbnails.js`)
   - ดึงข้อมูลฮาร์ดแวร์จาก OS โดยตรง (`os.cpus`, `os.freemem`, `fs.statfsSync`, `os.networkInterfaces`)

---

## 🗺️ 5. แผนการพัฒนาทีละขั้น (Roadmap แนะนำ) — *พัฒนาครบทั้ง 9 เฟสแล้ว!*

### ✅ Phase 1: Core Storage & UI (ระบบจัดเก็บไฟล์พื้นฐานและหน้าเว็บหลัก) — *[ดำเนินการแล้ว]*
- [x] **ระบบ Authentication:** หน้า Login พร้อมระบบจัดการ Session และผู้ใช้เริ่มต้น (`admin`)
- [x] **System Dashboard:** แสดงพื้นที่ Disk (Used / Free / Total), เปอร์เซ็นต์การใช้ CPU, RAM และหมายเลข LAN IP ของเครื่องเซิร์ฟเวอร์แบบ Real-time
- [x] **File Explorer บนเว็บ:**
  - ดูรายการไฟล์และโฟลเดอร์พร้อม Breadcrumb Navigation
  - สลับมุมมอง List View / Grid View, ค้นหาไฟล์, และ **จัดเรียงไฟล์ (Sort by ชื่อ / ขนาด / วันที่แก้ไข)**
  - สร้างโฟลเดอร์ใหม่ (Create Folder), เปลี่ยนชื่อ (Rename), **ย้าย (Move)** และ **คัดลอก (Copy)** ข้ามโฟลเดอร์
  - อัปโหลดไฟล์พร้อมแถบสถานะ (Progress Bar) และรองรับการลากวาง (Drag & Drop)
  - ดาวน์โหลดไฟล์ และเปิดดูตัวอย่างไฟล์เบื้องต้น (Preview รูปภาพ, วิดีโอ, เสียง, PDF, และแก้ไขไฟล์ข้อความ/โค้ดบนเว็บ)
- [x] **ระบบถังขยะ (Recycle Bin):**
  - ลบไฟล์/โฟลเดอร์เข้าถังขยะโดยไม่สูญหายทันที (รองรับการเลือกหลายรายการพร้อมกัน)
  - กู้คืนไฟล์ (Restore) กลับไปยังโฟลเดอร์ต้นทางเดิม หรือสั่งลบถาวร (Permanent Delete / Empty Trash)

### ✅ Phase 2: Media & Large Files (ระบบสื่อมัลติมีเดียและไฟล์ขนาดใหญ่) — *[ดำเนินการแล้ว]*
- [x] **Thumbnail Generator:** สร้างและแคชภาพย่อ (Thumbnails) สำหรับรูปภาพและวิดีโออัตโนมัติใน `storage/.cache/thumbnails/` เพื่อให้แสดงภาพตัวอย่างในหน้าเว็บได้รวดเร็ว
- [x] **Chunked & Resumable Upload:** หั่นไฟล์ขนาดใหญ่ออกเป็นชิ้นย่อยขณะอัปโหลด แสดงเปอร์เซ็นต์ความคืบหน้า (`%`), ความเร็ว (`MB/s`), เวลาที่เหลือ (`ETA`) แบบสดๆ รองรับการกดหยุดพัก (**⏸️ พัก / ▶️ ทำต่อ**) และอัปโหลดต่อจากจุดเดิมอัตโนมัติเมื่อเน็ตหลุด
- [x] **Multi-file ZIP Download:** เลือกหลายไฟล์หรือทั้งโฟลเดอร์แล้วดาวน์โหลดออกมาเป็นไฟล์ `.zip` แบบ Stream on-the-fly ทันที

### ✅ Phase 3: Multi-user & Sharing (ระบบหลายผู้ใช้และการแชร์ไฟล์) — *[ดำเนินการแล้ว]*
- [x] **User Management & Home Isolation:** แอดมินสามารถสร้าง/แก้ไข/ลบบัญชีผู้ใช้แยกแต่ละคน โดยแต่ละคนมีโฟลเดอร์ส่วนตัวแยกกัน (`storage/files/Users/{username}`) และตั้งค่านโยบายนามสกุลไฟล์ (Allow All / Blocklist / Allowlist) ได้
- [x] **Storage Quota:** กำหนดเพดานพื้นที่จัดเก็บข้อมูลรายบุคคล (เช่น จำกัดคนละ 10 GB) พร้อมคำนวณพื้นที่ใช้งานจริงและบล็อกการอัปโหลด/คัดลอกทันทีเมื่อเกินโควตา
- [x] **Public Share Links (`/s/:token`):** สร้างลิงก์สำหรับแชร์ไฟล์หรือโฟลเดอร์ให้คนภายนอกเข้าถึงได้โดยไม่ต้องมีบัญชี NAS พร้อมตั้งรหัสผ่านป้องกัน (Password Protection), วันหมดอายุ (Expiration Date), และจำกัดจำนวนครั้งที่ดาวน์โหลด (Max Downloads)

### ✅ Phase 4: Advanced NAS Features (ฟีเจอร์ระดับเซิร์ฟเวอร์ขั้นสูง) — *[ดำเนินการแล้ว]*
- [x] **WebDAV Server Integration (`/webdav/`):** เชื่อมต่อ NAS เข้ากับ Windows Explorer (Map Network Drive) หรือ macOS Finder (`Cmd + K`) ได้โดยตรงแบบอ่าน/เขียน (Read/Write) ไม่ต้องผ่านเว็บเบราว์เซอร์
- [x] **Fast File Indexing & Global Search (`src/indexer.js`):** ระบบสแกนและทำดัชนีไฟล์ทั้งหมดลง SQLite เพื่อค้นหาไฟล์ข้ามโฟลเดอร์ได้อย่างรวดเร็วและตรวจจับไฟล์ซ้ำด้วย SHA-256 (Duplicate Files Detector)
- [x] **Auto-Backup & Scheduled Tasks (`src/scheduler.js`):** ตั้งเวลาสร้างไฟล์สำรองข้อมูล `.zip` อัตโนมัติลง `storage/backups/`, หมุนเวียนชุดสำรองข้อมูลเก่า, และล้างไฟล์ในถังขยะอัตโนมัติเมื่อครบกำหนดวัน

### ✅ Phase 5: Smart & Enterprise NAS Features (ระบบอัจฉริยะและความปลอดภัยระดับ Enterprise) — *[ดำเนินการแล้ว]*
- [x] **Activity Audit Logs & Brute-force Protection (`src/phase5.js`):** บันทึกทุกเหตุการณ์สำคัญในระบบ (Login, Failed Login, Upload, Download, Delete, Share, File Edit, Remote URL Fetch, Version Rollback) พร้อมเลข IP และล็อก IP อัตโนมัติ 15 นาทีเมื่อล็อกอินผิดครบ 5 ครั้ง
- [x] **Favorites (Starred Files) & Quick File Creator:** ปักหมุดไฟล์และโฟลเดอร์สำคัญไว้ในหน้า `⭐ รายการโปรด` และปุ่ม `📝 สร้างไฟล์ใหม่` สำหรับสร้างไฟล์ข้อความ/Markdown/โค้ดบนเว็บได้ทันที
- [x] **Photo Gallery & Media Center with Lightbox Slideshow:** หน้า `📸 แกลเลอรีรูป & วิดีโอ` ที่รวบรวมสื่อจากทุกโฟลเดอร์พร้อมโหมดสไลด์โชว์เต็มจอ (`◀ ก่อนหน้า` / `ถัดไป ▶` และปุ่มลูกศรคีย์บอร์ด)
- [x] **Remote URL Downloader (Cloud Fetch):** วางลิงก์ไฟล์ภายนอก (`http://` หรือ `https://`) เพื่อให้เซิร์ฟเวอร์ NAS ดึงไฟล์ลงโฟลเดอร์ปลายทางโดยตรง
- [x] **File Versioning & Rollback (`storage/.cache/versions/`):** เก็บประวัติเวอร์ชันย้อนหลังของไฟล์อัตโนมัติทุกครั้งที่แก้ไขข้อความ (หรือกดสร้าง Snapshot เอง) พร้อมปุ่ม `⏪ ย้อนคืนเวอร์ชันนี้ (Rollback)` สูงสุด 10 เวอร์ชันต่อไฟล์

### ✅ Phase 6: Ultimate NAS Power Features (ฟีเจอร์ระดับท็อปของ NAS สมัยใหม่) — *[ดำเนินการแล้ว]*
- [x] **Online Archive Extractor & Compressor (`src/phase6.js`):** กด `📂 แตกไฟล์` บนไฟล์ `.zip`, `.tar`, `.tar.gz`, `.tgz` เพื่อแตกไฟล์ลงในโฟลเดอร์บน NAS ทันที (พร้อมระบบป้องกัน Zip-Slip) และกด `🗜️ บีบอัดเป็น .ZIP บน NAS` เพื่อสร้างไฟล์ `.zip` เก็บไว้ในโฟลเดอร์ปัจจุบัน
- [x] **File Drop / Upload Request Links (`/d/:token`):** สร้างลิงก์สาธารณะสำหรับรับฝากไฟล์จากบุคคลภายนอกเข้าสู่โฟลเดอร์ที่กำหนดโดยไม่ต้องมีบัญชี NAS (ตั้งรหัสผ่านลิงก์และวันหมดอายุได้)
- [x] **AES-256-GCM File Encryption Vault (`.vault`):** เข้ารหัสล็อกไฟล์ลับด้วยรหัสผ่านระดับฮาร์ดดิสก์ (`AES-256-GCM` + `scrypt` key derivation) และถอดรหัสกลับมาได้เฉพาะผู้ที่ทราบรหัสผ่าน
- [x] **Color Tags & File Notes:** ติดป้ายกำกับ 5 สี (`🔴 แดง`, `🟢 เขียว`, `🔵 น้ำเงิน`, `🟡 เหลือง`, `🟣 ม่วง`) พร้อมเขียนบันทึกช่วยจำ (Note) ประจำไฟล์ และกรองดูไฟล์ตามสีได้ทันที
- [x] **Deep Storage Analyzer:** หน้า `📈 วิเคราะห์พื้นที่เชิงลึก` แสดงกราฟสัดส่วนพื้นที่ตามประเภทไฟล์, จัดอันดับ 10 โฟลเดอร์ที่ใหญ่ที่สุด, และแสดง Top 20 ไฟล์ที่มีขนาดใหญ่ที่สุดใน NAS

### ✅ Phase 7: Ecosystem, Media & Collaboration Suite (ระบบสื่อบันเทิงและทำงานร่วมกันข้ามอุปกรณ์) — *[ดำเนินการแล้ว]*
- [x] **Music Jukebox & Persistent Mini Player (`src/phase7.js`):** หน้า `🎵 เพลง & เสียง (Jukebox)` รวบรวมไฟล์เสียงทั้งหมดใน NAS พร้อมแถบเครื่องเล่นลอยด้านล่าง (`#mini-audio-player`) ที่เล่นเพลงต่อเนื่องได้แม้เปลี่ยนหน้าหรือเปิดโฟลเดอร์อื่น รองรับก่อนหน้า/ถัดไป, สุ่มเพลง (Shuffle), และเล่นซ้ำ
- [x] **Cross-Device Clipboard & Snippet Hub:** หน้า `📋 คลิปบอร์ดข้ามเครื่อง` สำหรับส่งข้อความ, ลิงก์ยาวๆ, หรือโค้ดข้ามอุปกรณ์ในวง LAN (PC ↔ มือถือ/แท็บเล็ต) พร้อมปุ่มคัดลอกในคลิกเดียว หรือบันทึกเป็นไฟล์ `.txt` ลง NAS ทันที
- [x] **Smart Batch Rename (เปลี่ยนชื่อไฟล์เป็นกลุ่ม):** เลือกหลายไฟล์พร้อมกันแล้วเปลี่ยนชื่ออัตโนมัติตามแพตเทิร์นรันเลข (`File-001.jpg`), เติมคำนำหน้า/คำต่อท้าย (Prefix/Suffix), หรือค้นหาและแทนที่คำ (Find & Replace) พร้อมดูตัวอย่างชื่อใหม่แบบสดๆ
- [x] **File Checksum & Integrity Verifier (`MD5` / `SHA-1` / `SHA-256`):** ปุ่ม `#️⃣` บนการ์ดไฟล์เพื่อคำนวณค่าแฮชทั้ง 3 มาตรฐานแบบ Stream ในรอบเดียว และช่องวางค่าแฮชเพื่อตรวจสอบความถูกต้องของไฟล์อัตโนมัติ
- [x] **Send to NAS User Inbox (`📨 ส่งให้ผู้ใช้ใน NAS`):** ส่งสำเนาไฟล์หรือโฟลเดอร์เข้าสู่โฟลเดอร์ `/Inbox` ของเพื่อนร่วมระบบโดยตรง พร้อมแนบข้อความบันทึกช่วยจำ (`ข้อความแนบ-*.md`)

### ✅ Phase 8: Smart Workspace, Media Studio & Power Utilities (สมาร์ตเวิร์กสเปซ สตูดิโอแต่งภาพ และเครื่องมือระดับโปร) — *[ดำเนินการแล้ว]*
- [x] **Built-in SVG QR Code Generator (`src/phase8.js`):** สร้าง QR Code มาตรฐาน ISO/IEC 18004 แบบ Pure-JS Offline (`GET /api/qr`) สำหรับสแกนเข้าใช้งาน NAS ผ่านวง LAN (`http://<LAN-IP>:8080`), สแกนดาวน์โหลดลิงก์แชร์สาธารณะ (`/s/:token`), และสแกนส่งไฟล์เข้าลิงก์รับฝากไฟล์ (`/d/:token`) จากกล้องมือถือได้ทันที
- [x] **Full-Text Content Search / Grep (`ค้นหาคำข้างในเนื้อหาไฟล์`):** สแกนค้นหาคำหรือโค้ดที่อยู่ข้างในเนื้อหาไฟล์ข้อความ (`.txt`, `.md`, `.json`, `.csv`, `.js`, `.py`, `.html`, `.css`, `.sql`, `.log` ฯลฯ) ข้ามทุกโฟลเดอร์ พร้อมแสดงเลขบรรทัดและไฮไลต์คำที่พบ
- [x] **Built-in Image Studio & Metadata Inspector (`🎨 แต่งรูป`):** ตรวจสอบค่าความละเอียดภาพ/DPI/Color Space และสั่งหมุนภาพ (`90°`/`180°`/`270°`), พลิกภาพ (`ซ้าย-ขวา`/`บน-ล่าง`), ย่อขนาดภาพ (`Resize`), หรือแปลงนามสกุลภาพ (`.jpg`, `.png`, `.tiff`, `.bmp`, `.gif`) บน NAS ได้โดยตรง พร้อมสำรองเวอร์ชันเดิมอัตโนมัติ
- [x] **Kanban Task & Project Board (`📌 กระดานงาน Kanban`):** กระดานบริหารจัดการงาน 3 คอลัมน์ (**To Do**, **In Progress**, **Done**) ที่แนบ Path ไฟล์หรือโฟลเดอร์ใน NAS เข้ากับการ์ดงานได้และกดกระโดดไปยังโฟลเดอร์นั้นได้ในคลิกเดียว
- [x] **Rich Markdown & Interactive CSV Table Viewer:** เปิดไฟล์ `.md`/`.markdown` แบบเรนเดอร์สวยงาม และเปิดไฟล์ `.csv`/`.tsv` เป็นตารางข้อมูลพร้อมช่องค้นหากรองแถวแบบ Real-time สลับระหว่างโหมดอ่าน (`👁️ โหมดอ่านสวยงาม`) และโหมดแก้ไขโค้ดดิบ (`✏️ โหมดแก้ไขโค้ด`) ได้ทันที
- [x] **Command Palette (`Cmd + K` / `Ctrl + K`):** หน้าต่างสั่งงานด่วนด้วยคีย์บอร์ดสำหรับค้นหาคำสั่งลัด เปลี่ยนหน้า สลับโหมดมืด/สว่าง หรือเปิดไฟล์อย่างรวดเร็ว

### ✅ Phase 9: Pro UX, Finder Context Menu, Drag-to-Folder & Live Process Telemetry — *[ดำเนินการแล้ว]*
- [x] **Custom Right-Click Context Menu & Drag-to-Folder (`#file-context-menu`):** คลิกขวาที่ไฟล์หรือโฟลเดอร์เพื่อเปิดเมนูคำสั่งด่วนสไตล์ macOS Finder / WattVision และสามารถลากการ์ดไฟล์ไปวางทับการ์ดโฟลเดอร์เพื่อย้ายไฟล์เข้าโฟลเดอร์นั้นได้ทันที
- [x] **Mobile Drawer Sidebar & Bottom Quick Navigation (`#mobile-bottom-nav`):** ปุ่มเมนูแฮมเบอร์เกอร์ (`☰`) พร้อมเมนูสไลด์ด้านข้างและแถบนำทางด้านล่างสำหรับสมาร์ตโฟนและแท็บเล็ต
- [x] **Recent Files & Quick Access Bar (`#recent-files-strip`):** แถบแสดงไฟล์ที่แก้ไขหรือใช้งานล่าสุดด้านบนของหน้าจัดการไฟล์ (`GET /api/files/recent`) เพื่อเปิดทำงานต่อได้ในคลิกเดียว
- [x] **File Inspector Side Drawer (`#file-inspector-drawer`):** แถบแสดงข้อมูลเชิงลึกด้านขวาเมื่อกดดูรายละเอียดไฟล์
- [x] **Live Top Processes & NAS Engine Telemetry (`GET /api/system/processes`):** ตารางแสดงโปรเซสที่ใช้ CPU และ RAM สูงสุดบนเครื่องเซิร์ฟเวอร์แบบสดๆ พร้อมข้อมูล V8 Heap / RSS Memory ของโปรเซส NAS

---

## 🚀 วิธีเริ่มต้นใช้งาน (Getting Started)

### ความต้องการของระบบ
- **Node.js** เวอร์ชัน `22.5.0` ขึ้นไป (ใช้โมดูลมาตรฐานของ Node.js และ `node:sqlite` ในตัว ไม่ต้องติดตั้งแพ็กเกจภายนอก)

### การรันเซิร์ฟเวอร์
```bash
npm start
```

เมื่อรันแล้วสามารถเข้าใช้งานได้ผ่าน:
- **Web Dashboard (เครื่องตัวเอง):** `http://localhost:8080`
- **Web Dashboard (เครื่องอื่นในวง LAN / Wi-Fi):** `http://<LAN-IP>:8080`
- **WebDAV Network Drive (Finder / Windows Explorer):** `http://<LAN-IP>:8080/webdav/`

### บัญชีผู้ใช้เริ่มต้น (Default Login)
- **Username:** `admin`
- **Password:** `admin123`

---

## 📁 โครงสร้างโปรเจกต์ (Project Structure)

```text
nasproject/
├── README.md              # เอกสารอธิบายสถาปัตยกรรมและ Roadmap ทั้ง 4 เฟส
├── package.json           # สคริปต์สำหรับรันระบบ (พร้อมโหมด Auto-reload)
├── src/
│   ├── server.js          # HTTP Server, API Router หลัก & Public Share Portal
│   ├── db.js              # ระบบฐานข้อมูล SQLite (Users, Trash, Uploads, Shares, Settings, Kanban)
│   ├── auth.js            # ระบบยืนยันตัวตน (scrypt Hashing & Signed Session Token)
│   ├── system.js          # โมดูลวัดค่า CPU, RAM, Disk Space และ Network IP
│   ├── storage.js         # โมดูลจัดการไฟล์, Home Isolation, Quota, Extension Policy & Trash
│   ├── thumbnails.js      # โมดูลสร้างและแคชภาพย่อ (Thumbnail Generator)
│   ├── zip.js             # โมดูลสร้างและ Stream ไฟล์ .ZIP แบบ On-the-fly
│   ├── webdav.js          # โมดูล WebDAV Server (RFC 4918) สำหรับ Mount เป็น Network Drive
│   ├── indexer.js         # โมดูล SQLite File Indexer, Global Search & Duplicate Detector
│   ├── scheduler.js       # โมดูล Auto-Backup Snapshots & Auto-Trash Cleanup
│   ├── phase5.js          # โมดูล Audit Logs, Brute-force Lockout, Favorites, Gallery, Cloud Fetch & File Versioning
│   ├── phase6.js          # โมดูล Archive Extractor/Compressor, File Drop (/d/:token), AES-256 Vault, Color Tags & Storage Analyzer
│   ├── phase7.js          # โมดูล Music Jukebox, Cross-Device Clipboard, Batch Rename, File Checksum & User Inbox
│   ├── phase8.js          # โมดูล SVG QR Generator, Full-Text Grep Search, Image Studio & Kanban Board
│   └── phase9.js          # โมดูล Recent Files, Live Top Processes Telemetry & Session Lock Verification
├── public/
│   ├── index.html         # หน้า Web UI หลักของ NAS Dashboard และหน้า Public Share Portal
│   ├── styles.css         # สไตล์ชีตแบบ Modern Dark NAS UI
│   └── app.js             # โค้ดฝั่ง Frontend ทั้งหมด
├── data/                  # เก็บไฟล์ฐานข้อมูล SQLite (สร้างอัตโนมัติ)
└── storage/               # พื้นที่เก็บข้อมูลจริงของ NAS (สร้างอัตโนมัติ)
    ├── files/             # โฟลเดอร์เก็บไฟล์ทั้งหมด (และโฟลเดอร์แยกผู้ใช้ Users/{username})
    ├── trash/             # โฟลเดอร์พักไฟล์ที่ถูกลบ (Recycle Bin)
    ├── backups/           # โฟลเดอร์เก็บไฟล์สำรองข้อมูล .ZIP (Backup Snapshots)
    └── .cache/            # แคชภาพย่อ (thumbnails) และไฟล์อัปโหลดชั่วคราว (uploads)
```
