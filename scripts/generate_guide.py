"""
Generate LEARNING-GUIDE.pdf — a comprehensive walkthrough of the IPO
Manager codebase aimed at a non-coder who is learning programming via AI.

Run from the project root:
    python scripts/generate_guide.py
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm, mm
from reportlab.lib.colors import HexColor, black, white, grey
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak,
    Table, TableStyle, Preformatted, KeepTogether, NextPageTemplate,
    PageTemplate, Frame, BaseDocTemplate,
)
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.pdfgen import canvas
from pathlib import Path
import sys

# ─────────────────────────────────────────────────────────────────────────────
# Output target
# ─────────────────────────────────────────────────────────────────────────────

OUT_PATH = Path(__file__).resolve().parent.parent / "LEARNING-GUIDE.pdf"

# ─────────────────────────────────────────────────────────────────────────────
# Colors — match the app's dark vault aesthetic in print-friendly form
# ─────────────────────────────────────────────────────────────────────────────

ACCENT       = HexColor("#9c6d3f")   # darker gold (better print contrast)
ACCENT_DARK  = HexColor("#6e4e2c")
TEXT_BODY    = HexColor("#1c1c1c")
TEXT_DIM     = HexColor("#5a5a5a")
LINE_GREY    = HexColor("#cccccc")
CODE_BG      = HexColor("#f5f0e6")
CODE_BORDER  = HexColor("#d9c9a6")
CALLOUT_BG   = HexColor("#fff7e0")
CALLOUT_BORDER = HexColor("#d8b75a")
WARN_BG      = HexColor("#ffe9e0")
WARN_BORDER  = HexColor("#d97757")

# ─────────────────────────────────────────────────────────────────────────────
# Styles
# ─────────────────────────────────────────────────────────────────────────────

styles = getSampleStyleSheet()

style_cover_title = ParagraphStyle(
    'CoverTitle', parent=styles['Title'],
    fontName='Helvetica-Bold', fontSize=36, textColor=ACCENT,
    alignment=TA_CENTER, spaceAfter=12, leading=42,
)
style_cover_subtitle = ParagraphStyle(
    'CoverSubtitle', parent=styles['Normal'],
    fontName='Helvetica', fontSize=14, textColor=TEXT_DIM,
    alignment=TA_CENTER, spaceAfter=20, leading=20,
)
style_cover_body = ParagraphStyle(
    'CoverBody', parent=styles['Normal'],
    fontName='Helvetica', fontSize=11, textColor=TEXT_BODY,
    alignment=TA_CENTER, spaceAfter=6, leading=15,
)
style_h1 = ParagraphStyle(
    'H1', parent=styles['Heading1'],
    fontName='Helvetica-Bold', fontSize=22, textColor=ACCENT,
    spaceBefore=12, spaceAfter=10, leading=28, keepWithNext=True,
)
style_h2 = ParagraphStyle(
    'H2', parent=styles['Heading2'],
    fontName='Helvetica-Bold', fontSize=15, textColor=ACCENT_DARK,
    spaceBefore=14, spaceAfter=6, leading=20, keepWithNext=True,
)
style_h3 = ParagraphStyle(
    'H3', parent=styles['Heading3'],
    fontName='Helvetica-Bold', fontSize=12, textColor=TEXT_BODY,
    spaceBefore=10, spaceAfter=4, leading=16, keepWithNext=True,
)
style_body = ParagraphStyle(
    'Body', parent=styles['Normal'],
    fontName='Helvetica', fontSize=10.5, textColor=TEXT_BODY,
    alignment=TA_JUSTIFY, spaceAfter=8, leading=16,
)
style_dim = ParagraphStyle(
    'Dim', parent=style_body,
    textColor=TEXT_DIM, fontSize=9.5, leading=14,
)
style_bullet = ParagraphStyle(
    'Bullet', parent=style_body,
    leftIndent=18, bulletIndent=6, spaceAfter=5,
)
style_code = ParagraphStyle(
    'Code', parent=styles['Code'],
    fontName='Courier', fontSize=9, textColor=TEXT_BODY,
    backColor=CODE_BG, borderColor=CODE_BORDER, borderWidth=0.5,
    borderPadding=8, leftIndent=0, rightIndent=0,
    spaceBefore=4, spaceAfter=10, leading=12,
)
style_callout = ParagraphStyle(
    'Callout', parent=style_body,
    fontSize=10, leading=14,
    backColor=CALLOUT_BG, borderColor=CALLOUT_BORDER, borderWidth=0.5,
    borderPadding=10, leftIndent=0, rightIndent=0,
    spaceBefore=6, spaceAfter=10,
)
style_warn = ParagraphStyle(
    'Warn', parent=style_body,
    fontSize=10, leading=14,
    backColor=WARN_BG, borderColor=WARN_BORDER, borderWidth=0.5,
    borderPadding=10, leftIndent=0, rightIndent=0,
    spaceBefore=6, spaceAfter=10,
)
style_chapter_label = ParagraphStyle(
    'ChapterLabel', parent=styles['Normal'],
    fontName='Helvetica-Bold', fontSize=9, textColor=ACCENT,
    alignment=TA_LEFT, spaceAfter=4, leading=11,
)

# TOC styles
toc_style_0 = ParagraphStyle(
    'TOC0', fontName='Helvetica-Bold', fontSize=11.5, textColor=ACCENT_DARK,
    leftIndent=0, firstLineIndent=0, leading=18, spaceBefore=8,
)
toc_style_1 = ParagraphStyle(
    'TOC1', fontName='Helvetica', fontSize=10, textColor=TEXT_BODY,
    leftIndent=16, firstLineIndent=0, leading=14,
)
toc_style_2 = ParagraphStyle(
    'TOC2', fontName='Helvetica', fontSize=9, textColor=TEXT_DIM,
    leftIndent=32, firstLineIndent=0, leading=12,
)

# ─────────────────────────────────────────────────────────────────────────────
# Helper builders — short names so the content section reads easily
# ─────────────────────────────────────────────────────────────────────────────

def H1(text, story):
    story.append(PageBreak())
    story.append(Paragraph(text, style_h1))

def H2(text, story):
    story.append(Paragraph(text, style_h2))

def H3(text, story):
    story.append(Paragraph(text, style_h3))

def P(text, story):
    story.append(Paragraph(text, style_body))

def D(text, story):
    """Dim/secondary paragraph"""
    story.append(Paragraph(text, style_dim))

def B(bullets, story):
    """Bulleted list — bullets is a list of strings"""
    for b in bullets:
        story.append(Paragraph(b, style_bullet, bulletText="•"))

def CODE(text, story):
    story.append(Preformatted(text, style_code))

def CALLOUT(text, story):
    story.append(Paragraph(text, style_callout))

def WARN(text, story):
    story.append(Paragraph(text, style_warn))

def SP(h, story):
    story.append(Spacer(1, h * mm))

def TABLE(data, story, col_widths=None, header=True):
    """Simple table with light styling"""
    t = Table(data, colWidths=col_widths, repeatRows=1 if header else 0)
    ts = [
        ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('TEXTCOLOR', (0, 0), (-1, -1), TEXT_BODY),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('GRID', (0, 0), (-1, -1), 0.3, LINE_GREY),
    ]
    if header:
        ts.extend([
            ('BACKGROUND', (0, 0), (-1, 0), HexColor("#f0e7d5")),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('TEXTCOLOR', (0, 0), (-1, 0), ACCENT_DARK),
        ])
    t.setStyle(TableStyle(ts))
    story.append(t)
    SP(3, story)

# ─────────────────────────────────────────────────────────────────────────────
# Doc template with TOC awareness + footer (page numbers)
# ─────────────────────────────────────────────────────────────────────────────

class GuideDocTemplate(BaseDocTemplate):
    """Custom template: notifies the TOC of heading flowables + page-number footer."""

    def __init__(self, filename, **kw):
        super().__init__(filename, **kw)
        frame = Frame(self.leftMargin, self.bottomMargin,
                      self.width, self.height, id='normal')
        page_template = PageTemplate(id='Main', frames=frame,
                                     onPage=self._draw_footer)
        self.addPageTemplates([page_template])

    def afterFlowable(self, flowable):
        """Notify the TOC when an H1/H2 paragraph is rendered."""
        if isinstance(flowable, Paragraph):
            style_name = flowable.style.name
            text = flowable.getPlainText()
            if style_name == 'H1':
                self.notify('TOCEntry', (0, text, self.page))
            elif style_name == 'H2':
                self.notify('TOCEntry', (1, text, self.page))

    def _draw_footer(self, canv, doc):
        """Render a page number + running header at the bottom of each page."""
        canv.saveState()
        canv.setFont('Helvetica', 8)
        canv.setFillColor(TEXT_DIM)
        # Page number, right-aligned
        page_num = canv.getPageNumber()
        canv.drawRightString(A4[0] - 1.7 * cm, 1.2 * cm, f"Page {page_num}")
        # Left footer: doc title
        canv.drawString(1.7 * cm, 1.2 * cm, "IPO Manager — Learning Guide")
        # Thin rule above footer
        canv.setStrokeColor(LINE_GREY)
        canv.setLineWidth(0.3)
        canv.line(1.7 * cm, 1.6 * cm, A4[0] - 1.7 * cm, 1.6 * cm)
        canv.restoreState()


# ─────────────────────────────────────────────────────────────────────────────
# Content section builders — one per "Part" of the guide
# ─────────────────────────────────────────────────────────────────────────────

def section_cover(story):
    SP(60, story)
    story.append(Paragraph("IPO Manager", style_cover_title))
    story.append(Paragraph("A Complete Learning Guide for Non-Coders", style_cover_subtitle))
    SP(10, story)
    story.append(Paragraph("Understanding every folder, library, and decision behind a real Electron desktop application", style_cover_body))
    SP(40, story)
    story.append(Paragraph("From the encrypted vault to the Playwright automation,", style_cover_body))
    story.append(Paragraph("from the master password to the AU IPO bid submission —", style_cover_body))
    story.append(Paragraph("explained in plain English for a CA learning to code.", style_cover_body))
    SP(60, story)
    story.append(Paragraph("Version 0.1.0 &nbsp;·&nbsp; May 2026", style_cover_body))
    SP(10, story)
    story.append(Paragraph("Built and documented with the help of Claude (Anthropic).", style_cover_body))
    story.append(PageBreak())


def section_toc(story):
    story.append(Paragraph("Table of Contents", style_h1))
    SP(4, story)
    toc = TableOfContents()
    toc.levelStyles = [toc_style_0, toc_style_1, toc_style_2]
    story.append(toc)


def section_preface(story):
    H1("Preface — How to Read This Guide", story)

    P("Bhai, namaste. If you are reading this, you have either commissioned this app "
      "for your own use (in which case you already know the financial pain it solves), "
      "or you are looking at the codebase wondering where to start. Either way, the goal of "
      "this document is the same: <b>take you from zero programming knowledge to a confident "
      "understanding of how every piece of this application fits together.</b>", story)

    P("You are a Chartered Accountant. You think in terms of double-entry, reconciliation, "
      "regulatory compliance, and risk. That mental model is closer to programming than you "
      "might think — both are about <i>moving information from one place to another while "
      "preserving integrity</i>. Throughout this guide, when I introduce a programming concept, "
      "I will use an accounting or finance analogy wherever possible.", story)

    H2("Who this guide is for", story)
    B([
        "<b>Non-coders</b> who own this app and want to understand what is inside.",
        "<b>Learners</b> who want to see how a real desktop application is structured.",
        "<b>Future contributors</b> (you, or anyone you hire) who want to add features.",
        "<b>Auditors / security-conscious users</b> who want to know what data goes where.",
    ], story)

    H2("How to read it", story)
    P("The guide is organized in eleven Parts, ordered from most-conceptual to most-detailed. "
      "If you read end-to-end (recommended), it will take 3–4 hours. Parts 1–3 give you the "
      "big picture and answer <i>what does this do, and how</i>. Parts 4–5 explain "
      "<i>where everything lives on disk and why</i>. Parts 6–9 cover the security model, "
      "features, limitations, and risks. Part 10 traces a single click through the entire "
      "codebase as a worked example. Part 11 is a glossary you can refer back to.", story)

    H2("A note on screenshots", story)
    P("This document uses ASCII layouts (text-based diagrams) in monospace font to depict UI "
      "and folder structures. If you want, you can take real screenshots of your own machine "
      "and paste them next to the descriptions in your own annotated copy. The ASCII layouts "
      "are precise — they show exactly what you would see in the app or in your file explorer.", story)

    CALLOUT("<b>Tip:</b> Read this guide with the actual app open in one window and your "
            "file explorer open in another, navigating to each folder as it is described. "
            "Programming is a hands-on subject. The fastest way to understand a folder is to "
            "click into it.", story)


def section_part1_big_picture(story):
    H1("Part 1 — The Big Picture", story)

    H2("1.1 What is IPO Manager?", story)
    P("IPO Manager is a Windows desktop application that helps a Chartered Accountant (or any "
      "individual managing IPO applications for a large family) keep track of dozens of bank "
      "accounts, demat accounts, and IPO applications across multiple relatives — all in one "
      "encrypted vault.", story)
    P("It does three big things:", story)
    B([
        "<b>Stores credentials</b> for every relative's banks (AU, YES, SBI, KOTAK, ICICI, "
        "BOB, PNB, HDFC, AXIS) and brokers (Zerodha, Dhan, Angel One, Mirae, Shoonya, "
        "Fyers, Groww) — encrypted at rest, never sent anywhere.",
        "<b>Automates logins</b> — clicking a bank's name in the app opens a real browser, "
        "fills in user-id + password, fetches the OTP from Gmail, solves the CAPTCHA via "
        "Claude AI, and shows you the current balance.",
        "<b>Submits IPO bids on AU Bank</b> for any selected subset of family members — "
        "instead of logging in 35 times during a hot IPO window.",
    ], story)

    H2("1.2 The problem it solves", story)
    P("A practising CA's family commonly has 30+ demat accounts across multiple relatives "
      "(spouse, parents, in-laws, HUF, children once they turn 18). When a hot IPO opens, "
      "you have a 3-day window to apply on behalf of each one — and you want to maximize "
      "allotment chances, so each family member should apply separately.", story)

    P("Doing this manually means:", story)
    B([
        "Logging into 8 different bank websites, 30 times each — that's 240 logins.",
        "Each login needs a password (different per bank), maybe an OTP (different per "
        "bank, sent to different mobile numbers / emails), and sometimes a CAPTCHA.",
        "Once logged in, you navigate three or four menus to find the IPO bid page, enter "
        "the right amount, the right UPI or ASBA, and submit.",
        "If the bid fails (wrong amount, technical glitch, balance below minimum), you redo it.",
    ], story)

    P("This is a full week of work for one IPO. IPO Manager compresses it to a half-hour, "
      "with the user staying in control (the bid is shown for confirmation before "
      "submission — the app never silently sends money anywhere).", story)

    H2("1.3 Who uses it?", story)
    P("Currently: <b>one user</b> — the owner who commissioned this app. The architecture is "
      "single-user by design: there is one master password, one vault, one user's data on "
      "the machine. Multiple-machine sync (Phase 4) lets the same user run the app at home "
      "and at the office, with the vault synchronised through OneDrive or Google Drive.", story)

    P("A second-user scenario (e.g. handing the installer to a CA friend) is supported, "
      "but each user has their <i>own</i> independent vault. There is no shared cloud "
      "service, no multi-tenant SaaS — this is intentional. The whole point of a local-only "
      "encrypted vault is to avoid the regulatory and security overhead of cloud-hosted "
      "credentials.", story)

    H2("1.4 What does it look like conceptually?", story)
    P("The app is a single window. The left side is a sidebar with families and tools. "
      "The right side is the main panel, which shows either the all-members accordion view, "
      "a single-family deep view, or the spreadsheet grid view.", story)

    CODE("""+──────────────────────────────────────────────────────────────────────+
│  IPO Manager                                                         │
│  vault unlocked            [Lock]                                    │
│  [Gmail: gmail@example.com ready]                                    │
│  [CAPTCHA AI: Claude ready (3/100)]                                  │
│  [Backup: 2h ago]                                                    │
│                                                                      │
│  ┌── FAMILIES ──┐  ┌── ALL MEMBERS ─────────────────────────────────┐│
│  │ View All     │  │ ₹45L savings  ₹2.1Cr FD                        ││
│  │ Spreadsheet  │  │ [Edit] [Chittorgarh] [GMP] [Refresh All AU]    ││
│  │ • Sharma     │  │                                                ││
│  │ • Daiya      │  │ ┌─ Sharma Family ───────────────────────────┐  ││
│  │ • Solanki    │  │ │ Akshay Sharma                             │  ││
│  │ • Tiwari     │  │ │   [AU ₹1.2L] [YES ₹50k] [HDFC ₹3L]        │  ││
│  │              │  │ │   [Zerodha ₹15L portfolio] [Dhan ...]     │  ││
│  │ [+ Family]   │  │ │                                            │  ││
│  └──────────────┘  │ │ Spouse                                    │  ││
│                    │ │   [AU ₹80k] [HDFC ₹2L] ...                │  ││
│                    │ └────────────────────────────────────────────┘  ││
│                    └────────────────────────────────────────────────┘│
+──────────────────────────────────────────────────────────────────────+""", story)

    P("Everything you see here is rendered by the React framework running inside an "
      "Electron window. We will get to what that means in Part 2.", story)


def section_part2_concepts(story):
    H1("Part 2 — Foundational Concepts for Non-Coders", story)
    P("This Part introduces the building blocks. If you already know these terms, "
      "skim it. If you do not, read carefully — every later Part assumes you understand "
      "this vocabulary.", story)

    H2("2.1 What is a desktop application?", story)
    P("A <b>desktop application</b> is a program you double-click on Windows or macOS "
      "to run. It opens in its own window. Examples: Microsoft Word, Tally, Chrome, "
      "VLC media player. Contrast this with:", story)
    B([
        "<b>Web applications</b> — you visit a URL in a browser; the program runs on a "
        "remote server (Gmail, ICICI net banking, Quickbooks Online).",
        "<b>Mobile applications</b> — you install from Play Store or App Store; the "
        "program runs on your phone.",
    ], story)
    P("IPO Manager is a desktop application. It runs entirely on your Windows PC. There "
      "is no remote server holding your data. Your vault lives in a single file on your "
      "hard disk.", story)

    CALLOUT("<b>Why desktop and not web?</b> Banks and brokers do not have APIs we can "
            "call directly — we have to drive their websites with a real browser. A "
            "desktop app can launch and control a real browser; a web app cannot. Also, "
            "keeping credentials off any server eliminates an entire category of breach "
            "risk.", story)

    H2("2.2 The three worlds: Frontend, Backend, Database", story)
    P("Almost every application — desktop, web, or mobile — is structured as three "
      "cooperating layers:", story)

    TABLE([
        ["Layer", "What it does", "Where it lives", "In IPO Manager"],
        ["Frontend", "Draws the UI you see; handles clicks and keystrokes",
         "Renderer process",
         "src/renderer/ — React + TypeScript"],
        ["Backend", "Runs the actual work — calls APIs, drives browsers, encrypts/decrypts data, talks to the file system",
         "Main process",
         "src/main/ — TypeScript with Playwright + crypto"],
        ["Database", "Stores data persistently between runs",
         "Hard disk (an encrypted file)",
         "vault.db — SQLite + SQLCipher"],
    ], story, col_widths=[2.5*cm, 5.5*cm, 4.5*cm, 4.5*cm])

    P("The Frontend never touches your credentials directly. The Renderer process is "
      "sandboxed — it cannot open files on your disk or make network requests by itself. "
      "When you click \"Refresh AU\", the Renderer sends a message to the Main process: "
      "\"please run the AU login for Akshay\". The Main process does the real work, "
      "then sends the result back. This separation is a security feature.", story)

    H2("2.3 What is Electron?", story)
    P("<b>Electron</b> is a framework — a collection of pre-built components — that lets "
      "you build a desktop application using web technologies (HTML, CSS, JavaScript). It "
      "bundles together:", story)
    B([
        "<b>Chromium</b> — the open-source browser engine (the same engine inside Chrome) — "
        "to render the user interface.",
        "<b>Node.js</b> — a JavaScript runtime — to run the backend logic.",
        "<b>An IPC bridge</b> — Inter-Process Communication — so the frontend (Chromium) "
        "and backend (Node) can send messages to each other.",
    ], story)

    P("Why is this a big deal? Without Electron, building a Windows desktop app would mean "
      "learning C# or C++ — heavy languages with their own toolchains. Electron lets you "
      "use JavaScript everywhere. Slack, VS Code, Discord, WhatsApp Desktop, Signal — all "
      "are Electron apps.", story)

    P("Trade-off: Electron apps are bigger (they bundle Chromium = ~80 MB) and use more "
      "memory than native apps. For IPO Manager this is irrelevant — you have a desktop "
      "PC with plenty of RAM.", story)

    H2("2.4 JavaScript, TypeScript, Node.js — what's the difference?", story)
    P("<b>JavaScript</b> is the programming language that web pages use. It was invented "
      "in 1995 for use inside a browser. Today it runs everywhere — browsers, servers, "
      "phones, even Mars rovers.", story)
    P("<b>Node.js</b> is JavaScript running outside the browser. Specifically, it can read "
      "and write files, listen on network ports, spawn child processes — things a browser "
      "JavaScript engine cannot do. When you see code that imports 'node:fs' or 'node:path', "
      "that is Node-specific.", story)
    P("<b>TypeScript</b> is JavaScript plus type annotations. In plain JavaScript:", story)
    CODE("function add(a, b) { return a + b; }\nadd(2, 'hello');  // returns '2hello' — surprising!", story)
    P("In TypeScript:", story)
    CODE("function add(a: number, b: number): number {\n  return a + b;\n}\nadd(2, 'hello');  // compiler error before the program even runs", story)
    P("TypeScript catches a huge class of bugs <i>before</i> the program runs. The "
      "trade-off is that you have to write the type annotations. For a financial app like "
      "ours, where a misplaced character could leak a password or transfer the wrong "
      "amount, this safety net is worth the effort.", story)
    P("Every .ts file in IPO Manager gets compiled (transformed) into plain JavaScript "
      "before it actually runs. You can see the compiled output in the out/ folder.", story)

    H2("2.5 What is encryption?", story)
    P("<b>Encryption</b> is the process of scrambling information so that only someone "
      "with a secret key can unscramble it. There are two main flavours:", story)
    B([
        "<b>Symmetric encryption</b> — one key. Same key encrypts and decrypts. Used here "
        "for the vault (AES-256-GCM, SQLCipher).",
        "<b>Asymmetric (public-key) encryption</b> — two keys, a public one and a private "
        "one. Used here only indirectly (HTTPS connections to banks).",
    ], story)

    P("Three pieces of jargon you will see repeatedly:", story)
    B([
        "<b>Plaintext</b> — readable, unencrypted data. \"akshay@gmail.com\" is plaintext.",
        "<b>Ciphertext</b> — encrypted data. Looks like random bytes: <font face='Courier'>a3 7f 92 ee 01 ...</font>",
        "<b>Key</b> — the secret used to encrypt and decrypt. In our app, the key is "
        "derived from your master password using a function called Argon2id (more on that "
        "in Part 6).",
    ], story)

    P("A common beginner question: <i>if my master password derives the key, why not just "
      "store the password and use it directly?</i> Two reasons:", story)
    B([
        "Argon2id is intentionally slow (~500 ms per derivation). This makes it expensive "
        "for an attacker to try millions of passwords against a stolen vault file.",
        "The derived key is exactly 32 bytes — the size SQLCipher requires. Passwords are "
        "any length. So we still need a key-derivation step.",
    ], story)

    H2("2.6 What are libraries / packages?", story)
    P("A <b>library</b> (also called a <b>package</b>) is pre-written code that solves a "
      "specific problem. Instead of writing AES encryption from scratch (which is hard to "
      "get right and dangerous to mess up), we use a library that has been written and "
      "audited by experts.", story)

    P("Node.js libraries live in a folder called <font face='Courier'>node_modules/</font> "
      "and are listed in <font face='Courier'>package.json</font>. There are over a million "
      "publicly available packages on the npm registry. IPO Manager uses about a dozen "
      "directly.", story)

    P("Each library you add brings:", story)
    B([
        "Functionality you don't have to write yourself.",
        "A potential security risk — you are trusting the library's authors.",
        "A maintenance cost — libraries get updates, sometimes with breaking changes.",
    ], story)

    P("Picking libraries carefully is a real skill. For this project, every library was "
      "chosen for being either widely-used (Electron, React, Playwright) or "
      "domain-essential (Argon2, SQLCipher).", story)


def section_part3_end_to_end(story):
    H1("Part 3 — How the App Works End-to-End", story)

    H2("3.1 The journey of your master password (unlock flow)", story)
    P("Step by step, what happens when you launch the app and type your password:", story)
    CODE("""1. You double-click 'IPO Manager.exe' on your desktop.

2. Windows OS launches the Electron process. Electron starts:
   a. The main process (a Node.js runtime)
   b. The renderer process (a Chromium browser window)

3. The renderer loads index.html, which boots the React app.
   It calls window.api.vault.status() to check if a vault exists.

4. The main process replies:
   - If vault.meta.json exists in %APPDATA%\\ipo-manager\\data\\:
     status = initialized=true, so show the Unlock screen
   - Otherwise: status = initialized=false, show first-time setup

5. You type your master password and click Unlock.

6. The renderer sends 'vault:unlock' IPC message to the main process,
   with the password as the payload.

7. Main process calls deriveMasterKey(password):
   a. Read salt from vault.meta.json
   b. Run Argon2id(password, salt, memoryCost=256MB, timeCost=4)
   c. Result: 32-byte raw key
   This takes ~500 ms — intentionally slow to defeat brute-force.

8. Main process calls openDb(key):
   a. Create SQLite connection to vault.db
   b. Set the SQLCipher key via PRAGMA
   c. Run a test SELECT to verify the key works
   d. If it fails: throw INVALID_MASTER_PASSWORD; the renderer
      shows the error and waits for another password attempt
   e. If it succeeds: the DB is open and ready

9. The main process schedules an auto-backup 10 seconds later
   (giving you time to start interacting before the backup steals
   the disk).

10. The main process returns { ok: true } to the renderer.

11. The renderer transitions to the Splashing state. The Dashboard
    component mounts (invisible, behind the splash). It starts
    loading families, members, Gmail status, CAPTCHA status — all
    in parallel.

12. SplashScreen plays the 3-note D-major arpeggio via Web Audio API,
    rotates two gold rings around the IPO mark, fills the loading bar
    over 1.8 seconds. Then fades out.

13. When the splash fades, the Dashboard is already fully loaded.
    You see your families. The vault is unlocked.""", story)

    H2("3.2 The journey of a bank login (e.g. AU Bank for Akshay)", story)
    CODE("""1. You click on 'AU' next to Akshay's name in the dashboard.

2. The button's onClick calls loginBank(akshayId, auBank, familyId).

3. loginBank() sends 'login:bank' IPC to main process.

4. Main process runs runLogin('BANK', akshayId, auBank.id):
   a. SELECT * FROM bank_accounts WHERE id = ? AND member_id = ?
   b. Look up the adapter: getBankAdapter('AU') returns auBankAdapter
   c. Decrypt user_id_enc → 'akshaySharma123'
   d. Decrypt password_enc → '••••••••'
   e. Decrypt customer_id_enc → 'CUSTAU456789'

5. Main process calls launchSession({ profileKey: 'BANK-AU-42' }):
   a. Build the browser profile path
   b. Find Chrome.exe on disk
   c. Launch a real Chromium window with that profile
   d. Position and size the window

6. auBankAdapter.login(page, credentials, fetchOtp) runs:
   a. Navigate to https://retail.aubank.in/login
   b. Type the customer ID (CRN)
   c. Click 'Proceed'
   d. Type the password
   e. Wait for the CAPTCHA image
   f. Screenshot the CAPTCHA region
   g. Call solveCaptchaTextWithClaude(imageBytes)
      - Check usage gate: consented? under daily cap? → yes
      - POST to api.anthropic.com/v1/messages with the image
      - Anthropic responds with the 6-character solution
      - Record the call (today's count + token usage)
      - Return the text
   h. Type the captcha solution
   i. Click 'Login'
   j. Wait for OTP screen
   k. Call fetchOtp() — this watches Gmail for an AU OTP email
   l. Type the OTP
   m. Land on the dashboard page

7. If shouldFetchBalance is true:
   adapter.fetchBalance(page) reads the Savings and FD balances
   from the dashboard. Returns 'Savings: ₹8,141.37 | Deposit: ₹2,00,000.00'.

8. Main process updates bank_accounts.balance with the new string.

9. audit_log gets a row: action=LOGIN_BANK, target=AU,
   status=SUCCESS, member_id=akshayId.

10. Main process returns { ok: true, balance: '...' } to the renderer.

11. The renderer updates Akshay's AU chip in the UI.

The browser window stays open. You can switch to it manually to do
anything else you want — submit an IPO bid, transfer money, whatever.""", story)

    H2("3.3 The journey of an AU IPO bid (multi-member)", story)
    CODE("""1. You click 'AU IPO' in the All Members header.

2. The dropdown opens. You tick a family checkbox (selects all AU-capable
   members in that family). You tick another family. You see the count:
   'Start (12)'.

3. You click Start. The renderer iterates the selected members one by one.

4. For each member:
   a. Show the 'Prepare AU Bid' modal — pick the issue from the catalog,
      enter quantity (lots), pick CUTOFF or LIMIT.
   b. You click 'Open AU & Prepare'.
   c. Renderer sends 'ipo:prepareAuBid' IPC.
   d. Main process runs the full AU login flow (steps 6 above).
   e. Once logged in, the adapter navigates to the IPO page, picks
      the issue, fills the bid, screenshots the page.
   f. Returns { readyToSubmit, blockedAmount, warnings }.
   g. The 'Review' modal opens with the screenshot and details.
   h. You click 'Confirm & Submit'.
   i. Renderer sends 'ipo:confirmAuBid' IPC.
   j. Main process clicks 'Submit' on the AU page, captures the
      bank reference number, records the bid in ipo_bid_runs.
   k. Closes the browser context for this member.

5. After every member is done, the modal closes. The dashboard shows
   the updated bid records.

At no point does the app submit a bid without you clicking
'Confirm & Submit'. The 'Open AU & Prepare' step is reversible —
'Cancel' just closes the browser without recording anything.""", story)


# ─────────────────────────────────────────────────────────────────────────────
# Part 4 — Project folder structure (the BIG section)
# ─────────────────────────────────────────────────────────────────────────────

def section_part4_folders(story):
    H1("Part 4 — The Project Folder Structure", story)

    P("Open the folder <font face='Courier'>H:\\ipo-manager_1\\ipo-manager\\</font> in "
      "Windows Explorer. You will see something like this:", story)

    CODE("""ipo-manager/
├── .git/                       (hidden — version control internals)
├── .gitignore
├── dist/                       (build output — installer goes here)
├── docs/                       (project documentation)
├── node_modules/               (downloaded libraries — ~1 GB)
├── out/                        (compiled JS — produced by electron-vite)
├── scripts/                    (utility scripts like this PDF generator)
├── src/                        (THE SOURCE CODE — most important folder)
│   ├── main/                   (backend — Node.js side)
│   ├── preload/                (bridge between main and renderer)
│   └── renderer/               (frontend — React UI)
├── tests/                      (automated test files)
├── electron.vite.config.ts     (build config)
├── LEARNING-GUIDE.pdf          (this file)
├── package.json                (project manifest)
├── package-lock.json           (exact library versions)
├── PROGRESS.md                 (development changelog)
├── README.md                   (one-page project summary)
└── tsconfig.json               (TypeScript compiler config)""", story)

    P("Let me explain each folder and file in detail. We will visit them in the order "
      "you would naturally encounter them — most important first.", story)

    H2("4.1 package.json — the project manifest", story)
    P("This is the single most important configuration file. It declares:", story)
    B([
        "The name and version of the project (\"ipo-manager\", \"0.1.0\").",
        "The list of <b>dependencies</b> — libraries the running app needs.",
        "The list of <b>devDependencies</b> — libraries needed only to build/test.",
        "Scripts that can be run with <font face='Courier'>npm run X</font>.",
        "The <b>build</b> configuration for electron-builder (installer settings).",
    ], story)
    P("Here are the actual scripts defined:", story)
    CODE('''"scripts": {
  "dev":         "electron-vite dev",
  "build":       "electron-vite build",
  "build:win":   "electron-vite build && electron-builder --win",
  "test":        "vitest run",
  "test:watch":  "vitest",
  "postinstall": "electron-builder install-app-deps && playwright install chromium"
}''', story)
    P("When you ran <font face='Courier'>npm install</font> for the first time, the "
      "<font face='Courier'>postinstall</font> script automatically downloaded "
      "Playwright's Chromium binary and rebuilt all native modules for your Electron "
      "version. That is why a fresh clone takes ~5 minutes — it is downloading hundreds "
      "of megabytes of dependencies.", story)

    H2("4.2 src/ — the source code", story)
    P("This is the only folder you will ever edit by hand. Everything else is either "
      "generated, configuration, or downloaded.", story)

    H3("4.2.1 src/main/ — the backend (Node.js side)", story)
    P("This folder contains the code that runs in the Main process — the part of "
      "Electron with full access to the file system, network, OS, and native modules.", story)
    CODE("""src/main/
├── index.ts                    (entry point — boots the app, creates the window)
├── activity.ts                 (auto-lock timer logic — 30 min idle = lock)
├── ipc.ts                      (IPC handlers — 1500 lines of message routing)
├── logging.ts                  (writes automation.log)
├── ai/
│   ├── anthropic.ts            (Claude API wrapper for CAPTCHA solving)
│   ├── captcha.ts              (provider abstraction)
│   └── usage.ts                (daily cap + consent tracking)
├── automation/
│   ├── browser.ts              (Playwright launcher & shared helpers)
│   ├── registry.ts             (maps bank/broker codes to adapters)
│   ├── auBank.ts               (AU Bank login + IPO adapter)
│   ├── sbiBank.ts              (SBI login + balance fetch)
│   ├── yesBank.ts
│   ├── kotakBank.ts
│   ├── iciciBank.ts
│   ├── bobBank.ts
│   ├── pnbBank.ts
│   ├── hdfcBank.ts
│   ├── axisBank.ts
│   ├── genericBank.ts          (fallback template)
│   ├── zerodha.ts              (Zerodha broker adapter)
│   ├── dhan.ts
│   ├── angel.ts
│   ├── mirae.ts
│   ├── shoonya.ts
│   ├── fyers.ts
│   └── groww.ts
├── backup/
│   └── engine.ts               (encrypted incremental backup engine)
├── crypto/
│   ├── master.ts               (Argon2id key derivation from master password)
│   └── field.ts                (AES-256-GCM field encryption)
├── db/
│   ├── connection.ts           (opens SQLCipher database, runs migrations)
│   ├── schema.sql              (table definitions — for humans to read)
│   └── schema.ts               (table definitions — inlined for runtime)
├── documents/
│   └── storage.ts              (encrypted PDF/JPEG storage)
├── email/
│   └── gmail.ts                (Gmail OAuth + OTP fetcher)
├── exporter/
│   └── excel.ts                (exports vault to Excel for backup)
├── importer/
│   └── excel.ts                (parses Demat_Sheet.xlsx for first-time load)
├── ipo/
│   └── catalog.ts              (BSE scraper for IPO master list)
└── reports/
    ├── storage.ts
    ├── angelWorkbook.ts        (parses Angel Excel portfolio report)
    ├── dhanWorkbook.ts
    └── zerodhaWorkbook.ts""", story)

    P("Each file has a specific job. Let me explain the most important ones in detail.", story)

    H3("index.ts — the entry point", story)
    P("This is what runs first when Electron starts. It does five things:", story)
    B([
        "Creates the BrowserWindow (1280 × 820 pixels, dark background).",
        "Removes the default menu bar (cleaner look).",
        "Tells Electron to show the window only after it is ready to render (no white flash).",
        "Registers all the IPC handlers from ipc.ts.",
        "Starts the auto-lock timer (checks every 30 seconds if the user has been idle 30+ minutes).",
    ], story)

    H3("ipc.ts — the message router", story)
    P("Most of the backend logic lives here. It is a giant file (about 1500 lines) "
      "that registers every IPC handler the renderer can call. Each handler looks like:", story)
    CODE("""ipc.handle('families:list', () => {
  const db = getDb();
  return db.prepare('SELECT * FROM families ORDER BY display_order').all();
});""", story)
    P("That handler responds to messages with the name 'families:list'. It reads from "
      "the database and returns the rows. The renderer calls it like:", story)
    CODE("const families = await window.api.families.list();", story)
    P("In a future refactor we should split ipc.ts by domain — ipc/vault.ts, "
      "ipc/families.ts, ipc/login.ts, etc. — to make the file easier to navigate. For "
      "now it is one big file.", story)

    H3("crypto/master.ts — turning a password into a key", story)
    P("When you type your master password, this file's deriveMasterKey() function "
      "runs the Argon2id algorithm to produce a 32-byte key. The key, not the password, "
      "is then handed to SQLCipher. Argon2id is designed to be:", story)
    B([
        "<b>Memory-hard</b> — needs 256 MB of RAM to compute, which makes it impractical "
        "for GPU-based brute-force attacks (GPUs have lots of cores but limited RAM "
        "per core).",
        "<b>Time-hard</b> — takes ~500 ms per try on a modern CPU. An attacker testing "
        "1 million passwords needs 5.7 days (vs. milliseconds for simpler KDFs).",
        "<b>Deterministic</b> — same password + same salt = same key. Without the salt "
        "(which is stored in vault.meta.json), the same password would give a different "
        "key on every machine. The salt is not secret — it is stored next to the vault.",
    ], story)

    H3("crypto/field.ts — encrypting individual fields", story)
    P("Even with SQLCipher protecting the whole database file, we add a second layer: "
      "each sensitive value (password, PAN, Aadhaar, account number) is also encrypted "
      "with AES-256-GCM using a separate key stored in the OS keychain. This is "
      "defense-in-depth: an attacker who somehow gets the DB file <i>and</i> guesses "
      "the master password still cannot read the credentials without OS-level access.", story)

    H3("db/connection.ts — opening the database", story)
    P("Opens the SQLite file, sets the SQLCipher key, runs any pending migrations "
      "(idempotent schema upgrades — e.g. \"if the email_password_enc column doesn't "
      "exist, ALTER TABLE to add it\"). The migrations let an old database work with "
      "a newer version of the app without losing data.", story)

    H3("automation/browser.ts — launching Playwright", story)
    P("This file handles everything about the real browser windows we open. It:", story)
    B([
        "Finds chrome.exe or msedge.exe on the user's machine (system Program Files OR per-user LocalAppData).",
        "Creates a persistent profile directory per (member, bank/broker) so cookies "
        "are remembered between logins.",
        "Configures the browser to disable safebrowsing download warnings (so the "
        "automation can save broker reports without a popup).",
        "Provides shared helpers used by every adapter — getMostRecentOpenPage, "
        "resolveBrowserDownload, etc.",
        "Provides closeAllBrowserSessions() and purgeBrowserProfiles() for the "
        "lock-time cleanup.",
    ], story)

    H3("automation/registry.ts — the adapter index", story)
    P("A tiny file that maps bank/broker codes to adapter implementations:", story)
    CODE("""const BANK_ADAPTERS = {
  AU:    auBankAdapter,
  YES:   yesBankAdapter,
  SBI:   sbiBankAdapter,
  // ...
};

export function getBankAdapter(code) {
  return BANK_ADAPTERS[code] || null;
}""", story)

    H3("automation/auBank.ts — the most complex adapter", story)
    P("AU Bank gets the most attention because it is the bank we use to file IPO "
      "bids. It includes:", story)
    B([
        "login() — the full multi-step login flow (CRN → password → CAPTCHA → OTP → dashboard)",
        "fetchBalance() — scrapes Savings + FD from the dashboard",
        "prepareIpoBid() — navigates to the IPO page, fills the bid, screenshots for review",
        "submitPreparedIpoBid() — clicks final Submit and captures the bank reference",
    ], story)

    H3("backup/engine.ts — the backup system", story)
    P("Built recently to solve the catastrophic-data-loss risk. Implements:", story)
    B([
        "createSnapshot() — produces a content-addressed incremental snapshot",
        "listSnapshots() — groups them by Last 24h / 7d / 30d / 6mo retention bands",
        "restoreSnapshot() — re-derives the key from the snapshot's own salt (critical for "
        "cross-machine restore)",
        "pruneOldSnapshots() — applies the retention policy",
        "garbageCollectBlobs() — deletes documents no surviving snapshot references",
    ], story)

    H3("4.2.2 src/renderer/ — the frontend (React UI)", story)
    CODE("""src/renderer/
├── index.html                  (the HTML shell — almost empty, React fills it in)
└── src/
    ├── main.tsx                (React entry point — calls root.render(<App />))
    ├── App.tsx                 (top-level state machine: loading → unlock → unlocked)
    ├── styles.css              (3000+ lines of CSS — the entire visual design)
    ├── assets/
    │   └── logos/              (PNG/SVG logos for HDFC, ANGEL, PNB, etc.)
    └── pages/
        ├── Unlock.tsx          (the master password screen)
        ├── SplashScreen.tsx    (3-note unlock sound + revolving gold rings)
        └── Dashboard.tsx       (4200 lines — almost all the UI lives here)""", story)

    P("Notice the asymmetry: the main process has ~30 files; the renderer has just 4 "
      "real component files. That is because Dashboard.tsx is a giant monolith that "
      "needs to be split into smaller pieces in a future refactor. For now, it works.", story)

    H3("App.tsx — the top-level state machine", story)
    P("This is the React component that controls which screen the user sees. It manages "
      "four states:", story)
    B([
        "<b>loading</b> — initial state, shows \"Loading...\" while checking vault status.",
        "<b>unlock</b> — shows the password screen. Subdivided into firstTime / not-firstTime.",
        "<b>splashing</b> — vault just unlocked; show the splash overlay while Dashboard "
        "loads data in the background.",
        "<b>unlocked</b> — Dashboard is fully visible; the splash is gone.",
    ], story)

    H3("Dashboard.tsx — almost everything", story)
    P("This single file contains: the sidebar, the All Members view, the single-family "
      "view, the Spreadsheet view, every modal (member edit, AU bid prep, AU bid review, "
      "service config, backup settings, restore, member detail card, change password), "
      "the bulk action handlers, the toast notification system, the drag-and-drop reorder "
      "logic, the IPC call wrappers, and many small utility functions.", story)

    P("4200 lines in one file is too many. The next refactor should split this into:", story)
    B([
        "components/Sidebar.tsx",
        "components/FamilyAccordion.tsx",
        "components/MemberRow.tsx",
        "components/BackupSettingsModal.tsx",
        "components/MemberDetailCard.tsx",
        "components/SpreadsheetView.tsx",
        "hooks/useBackupStatus.ts, useCaptchaUsage.ts, useGmailStatus.ts",
    ], story)
    P("But it is not a priority right now — the file works and changes to it are "
      "rare. We will revisit this when adding the auto-bid scheduler feature.", story)

    H3("4.2.3 src/preload/ — the bridge", story)
    CODE("""src/preload/
└── index.ts                    (about 100 lines — defines window.api)""", story)
    P("The preload script is the contract between the main and renderer processes. "
      "It is the <i>only</i> code that can call ipcRenderer.invoke() from the renderer. "
      "Without preload, the renderer (running in a sandboxed Chromium tab) would have "
      "no way to talk to the main process.", story)
    P("Every IPC call the renderer makes goes through window.api, which is defined here. "
      "For example:", story)
    CODE("""const api = {
  vault: {
    status: () => ipcRenderer.invoke('vault:status'),
    unlock: (pw) => ipcRenderer.invoke('vault:unlock', pw),
    lock:   () => ipcRenderer.invoke('vault:lock'),
    // ...
  },
  families: {
    list:   () => ipcRenderer.invoke('families:list'),
    create: (name, min) => ipcRenderer.invoke('families:create', { family_name: name, min_balance: min }),
    // ...
  },
  // ... and so on for backup, login, captchaAi, gmail, ipo, etc.
};

contextBridge.exposeInMainWorld('api', api);""", story)
    P("This bridge is a deliberately narrow surface. The renderer can <i>only</i> call "
      "the methods listed in window.api. It cannot, for instance, read arbitrary files "
      "or run arbitrary IPC channels. This is a security boundary.", story)

    H2("4.3 node_modules/ — the downloaded libraries", story)
    P("After running <font face='Courier'>npm install</font>, you will see a "
      "<font face='Courier'>node_modules/</font> folder roughly 1 GB in size, containing "
      "hundreds of subdirectories. Each subdirectory is a downloaded library. You almost "
      "never look inside this folder — it is managed automatically.", story)
    P("Think of it like a vendor's warehouse you don't catalogue yourself. The "
      "package-lock.json file is the inventory list — it records the exact version of "
      "every library so that the next person who runs npm install gets identical "
      "bytes.", story)

    H2("4.4 dist/ — the build output", story)
    P("When you run <font face='Courier'>npm run build:win</font>, the installer goes "
      "here. After a successful build you will see:", story)
    CODE("""dist/
├── win-unpacked/                            (the app, unpacked)
│   ├── IPO Manager.exe                      (the actual program)
│   ├── resources/
│   │   ├── app.asar                         (your compiled code, packed)
│   │   └── app.asar.unpacked/               (native modules that can't be in .asar)
│   ├── ffmpeg.dll, vk_swiftshader.dll, ...  (Chromium support DLLs)
│   └── locales/                             (Chromium translations)
├── IPO-Manager-Setup-0.1.0-x64.exe          (THE INSTALLER — share this file)
├── IPO-Manager-Setup-0.1.0-x64.exe.blockmap
└── builder-effective-config.yaml""", story)
    P("The single file you share with someone else is "
      "<font face='Courier'>IPO-Manager-Setup-0.1.0-x64.exe</font> (about 100 MB). "
      "Everything else is build scaffolding.", story)

    H2("4.5 out/ — the compiled JavaScript", story)
    P("When the build runs, electron-vite transforms every .ts file in src/ into a .js "
      "file in out/. This is a <i>technical</i> step that you almost never need to look "
      "at. The compiled code is what Electron actually executes.", story)
    CODE("""out/
├── main/
│   └── index.js     (all of src/main/ combined into one ~400 KB file)
├── preload/
│   └── index.js     (~5 KB)
└── renderer/
    ├── index.html
    └── assets/
        ├── index-XXXX.js   (the React app, ~450 KB)
        ├── index-XXXX.css  (the compiled styles, ~65 KB)
        └── *.png, *.svg    (the bank/broker logos)""", story)

    H2("4.6 tests/ — automated tests", story)
    CODE("""tests/
├── _stubs/
│   └── keytar.ts                (in-memory keychain stub for tests)
├── backup/
│   └── engine.test.ts           (cross-salt restore — conditionally skipped)
└── crypto/
    ├── master.test.ts           (Argon2 round-trip + salt sensitivity)
    └── field.test.ts            (AES-GCM round-trip + tamper detection)""", story)
    P("Right now there are 18 tests passing + 4 conditionally skipped. The skipped "
      "ones need Electron's Node ABI to load the SQLite native module. The tests "
      "run with <font face='Courier'>npm test</font> in about 7 seconds.", story)

    H2("4.7 Configuration files", story)
    H3("tsconfig.json", story)
    P("Tells the TypeScript compiler how to behave: which version of JavaScript to "
      "emit, where to find type definitions, which directories to compile. You almost "
      "never need to edit this file.", story)
    H3("electron.vite.config.ts", story)
    P("Tells electron-vite (the build tool) how to build the three parts (main, "
      "preload, renderer). Each part gets its own build pipeline because they have "
      "different requirements (renderer needs HTML+CSS+JS bundling; main needs "
      "Node-compatible output).", story)
    H3(".gitignore", story)
    P("Lists files and folders that should NOT be tracked in version control: "
      "node_modules/, dist/, out/, vault.db, etc. This keeps the repo small and "
      "prevents committing sensitive data by accident.", story)


# ─────────────────────────────────────────────────────────────────────────────
# Part 5 — Libraries
# ─────────────────────────────────────────────────────────────────────────────

def section_part5_libraries(story):
    H1("Part 5 — Every Library, Explained", story)
    P("This Part walks through each library the app depends on. For each one I will "
      "tell you what it does, why it is here, what would break if it were removed, "
      "and what the alternatives are.", story)

    H2("5.1 electron — the desktop app framework", story)
    P("<b>What it does:</b> bundles Chromium + Node.js into a single distributable "
      "app. Provides the BrowserWindow class to create OS-native windows, the ipcMain "
      "and ipcRenderer modules for cross-process messaging, the app and dialog modules "
      "for OS integration.", story)
    P("<b>Why this app needs it:</b> without Electron we couldn't run JavaScript code "
      "with file-system access on Windows. The alternative would be writing a separate "
      "Windows app in C#/WPF, plus a separate Mac app in Swift — three times the work.", story)
    P("<b>Alternatives:</b> Tauri (uses native webview, smaller bundle), Wails (Go-based), "
      "Neutralino (very lightweight). For our use case Electron's maturity wins.", story)

    H2("5.2 react + react-dom — the UI framework", story)
    P("<b>What it does:</b> a JavaScript library for building component-based user "
      "interfaces. Lets you describe the UI as a function of state, and re-renders "
      "automatically when state changes.", story)
    P("<b>Why this app needs it:</b> the dashboard has lots of interactive state — "
      "selected family, expanded accordion rows, open modal, edit mode toggle, busy "
      "spinners. React makes managing this state predictable.", story)
    P("<b>Alternatives:</b> Vue, Svelte, Solid. All work; React was picked for "
      "familiarity and ecosystem size.", story)

    H2("5.3 typescript — the type-safety layer", story)
    P("<b>What it does:</b> adds optional type annotations to JavaScript, catches "
      "type-related errors at build time before the program runs.", story)
    P("<b>Why this app needs it:</b> a financial app cannot afford runtime type "
      "surprises. \"Did you mean to pass a number where a string was expected?\" "
      "should be caught at the compiler, not by a confused user.", story)
    P("<b>Alternatives:</b> Flow (Facebook's TS competitor — losing ground), "
      "JSDoc-typed JavaScript (less ergonomic).", story)

    H2("5.4 playwright — the browser automation engine", story)
    P("<b>What it does:</b> launches and controls a real web browser (Chromium, "
      "Firefox, or WebKit) from your code. You can fill forms, click buttons, take "
      "screenshots, download files, intercept network requests, and so on.", story)
    P("<b>Why this app needs it:</b> banks and brokers do not have programmer-friendly "
      "APIs we can call. To check a balance or submit an IPO bid, we have to drive "
      "their website like a human would. Playwright lets us automate that "
      "reliably.", story)
    P("<b>Alternatives:</b> Puppeteer (Google's predecessor — same author moved to "
      "Playwright), Selenium (older, slower, more fragile). Playwright is the "
      "modern standard.", story)
    CALLOUT("<b>Why we use a real Chrome instead of a headless one:</b> banks deploy "
            "bot-detection. A real visible Chromium with normal user-agent and a "
            "real profile directory is much less likely to be flagged than a "
            "headless browser. It also lets you intervene manually if the "
            "automation hits an unexpected screen.", story)

    H2("5.5 better-sqlite3-multiple-ciphers — encrypted SQLite", story)
    P("<b>What it does:</b> a Node.js binding to SQLite — a tiny, file-based database. "
      "The 'multiple-ciphers' variant adds SQLCipher: every page of the database file "
      "is encrypted with AES-256 before being written to disk.", story)
    P("<b>Why this app needs it:</b> we need a database (lots of structured queries on "
      "families, members, bank accounts), it must be local (no server), and the file "
      "must be useless without the master password. SQLite + SQLCipher checks all three "
      "boxes.", story)
    P("<b>Alternatives:</b> raw SQLite + manual file encryption (more work, more bugs); "
      "a server-based DB like PostgreSQL (defeats the local-only design); a JSON file "
      "(can't handle complex queries efficiently). SQLite + SQLCipher is the right "
      "tool.", story)

    H2("5.6 argon2 — the password hashing library", story)
    P("<b>What it does:</b> implements the Argon2id algorithm — the modern "
      "best-practice for turning a user password into a cryptographic key.", story)
    P("<b>Why this app needs it:</b> we cannot use the password directly as the "
      "encryption key (passwords are short and predictable; keys must be long and "
      "uniform). Argon2id is intentionally slow and memory-heavy, making "
      "brute-force attacks prohibitively expensive.", story)
    P("<b>Alternatives:</b> bcrypt (older, GPU-attackable), scrypt (similar to "
      "Argon2 but less standardised), PBKDF2 (much weaker against GPUs). Argon2id "
      "won the Password Hashing Competition in 2015 and is the consensus modern "
      "choice.", story)

    H2("5.7 keytar — the OS keychain bridge", story)
    P("<b>What it does:</b> stores and retrieves passwords/keys from the operating "
      "system's secure credential store — Windows Credential Manager on Windows, "
      "Keychain on macOS, libsecret on Linux.", story)
    P("<b>Why this app needs it:</b> the per-field encryption key has to be stored "
      "<i>somewhere</i>. Storing it in a plain file would defeat the purpose. The OS "
      "keychain is the right place — protected by the user's OS login, isolated "
      "from other apps.", story)
    P("<b>Three entries</b> this app creates:", story)
    B([
        "<font face='Courier'>ipo-manager / field-encryption-key-v1</font> — the 32-byte "
        "field encryption key (random per-machine).",
        "<font face='Courier'>ipo-manager / gmail-refresh-token-v1</font> — the OAuth "
        "refresh token for Gmail.",
        "<font face='Courier'>ipo-manager / anthropic-api-key-v1</font> — your "
        "Anthropic API key for CAPTCHA solving.",
    ], story)
    P("You can see all three in Windows: Control Panel → Credential Manager → Windows "
      "Credentials → ipo-manager.", story)

    H2("5.8 googleapis — the Gmail API client", story)
    P("<b>What it does:</b> Google's official Node.js client for all their APIs. We "
      "use only the Gmail subset to watch for OTP emails.", story)
    P("<b>Why this app needs it:</b> when a bank sends an OTP to your email, we need "
      "to read it programmatically. Google's API provides a clean way: search for "
      "messages matching a query, extract the body, regex out the 6-digit code.", story)
    P("<b>OAuth flow:</b> first time you connect Gmail, the app opens your browser, "
      "you sign in to Google, Google sends back a refresh token. We store that token "
      "in keytar. From then on, the token is used to issue short-lived access tokens "
      "automatically — you never need to sign in again unless you revoke access.", story)

    H2("5.9 electron-vite + vite + electron-builder — the build chain", story)
    P("<b>vite:</b> the underlying build tool. Compiles TypeScript, bundles "
      "JavaScript modules, transforms CSS, ships an HTML index.", story)
    P("<b>electron-vite:</b> a thin wrapper that knows about the three-part structure "
      "of an Electron app (main / preload / renderer). Runs vite three times with "
      "different configs.", story)
    P("<b>electron-builder:</b> takes the compiled out/ directory plus your "
      "node_modules and packages it into the .exe installer. Handles code signing, "
      "auto-updater integration, NSIS installer scripting.", story)

    H2("5.10 Specialty libraries", story)
    H3("xlsx (SheetJS)", story)
    P("Reads and writes Excel spreadsheets. We use it for the initial import of the "
      "Demat_Sheet.xlsx and for exporting a plain Excel copy of the vault.", story)
    H3("tesseract.js", story)
    P("Optical character recognition (OCR) — extracts text from images. Bundled but "
      "not currently used; was originally an alternative to Anthropic for CAPTCHA "
      "solving.", story)
    H3("pngjs", story)
    P("Reads and writes PNG image files in pure JavaScript. Used for screenshot "
      "processing before sending to the CAPTCHA solver.", story)
    H3("totp-generator", story)
    P("Generates 6-digit TOTP (Time-based One-Time Password) codes from a base32 "
      "secret — the same algorithm Google Authenticator uses. Used for brokers that "
      "require TOTP login.", story)

    H2("5.11 vitest — the test runner", story)
    P("<b>What it does:</b> runs the files in tests/ and reports which pass and "
      "which fail.", story)
    P("<b>Why we use it:</b> vitest is the fastest popular test runner for "
      "TypeScript projects. It reuses our vite config, so tests have the same "
      "module resolution as production code.", story)


# ─────────────────────────────────────────────────────────────────────────────
# Part 6 — Security
# ─────────────────────────────────────────────────────────────────────────────

def section_part6_security(story):
    H1("Part 6 — The Security Model", story)
    P("This Part is the most important for any user storing 30+ relatives' "
      "credentials. Read it carefully.", story)

    H2("6.1 Defense in depth", story)
    P("Security people use a phrase: <i>defense in depth</i>. It means: don't "
      "rely on one wall. Build many walls, each of which would need to be "
      "breached for the attacker to succeed. IPO Manager has four walls:", story)
    B([
        "<b>Wall 1 — the OS user account.</b> The vault file lives in your Windows "
        "user profile. Another user on the same PC cannot see it (unless they are "
        "an administrator).",
        "<b>Wall 2 — SQLCipher.</b> The entire database file is encrypted with a "
        "key derived from your master password via Argon2id. An attacker with the "
        "file but no password cannot read a single row.",
        "<b>Wall 3 — field-level encryption.</b> Sensitive columns (PAN, Aadhaar, "
        "passwords) are encrypted a second time with a random 32-byte key stored "
        "in the OS keychain. An attacker who has the DB file AND has guessed the "
        "master password still cannot read credentials without keychain access.",
        "<b>Wall 4 — the OS keychain.</b> The field encryption key is protected by "
        "the OS's own credential store. On Windows, that is Credential Manager, "
        "protected by your Windows login.",
    ], story)

    P("To read your stored bank password, an attacker would need to bypass all four "
      "walls. The realistic ways that could happen are surprisingly limited "
      "(covered in 6.4).", story)

    H2("6.2 The three encryption layers", story)
    P("Layer 1: <b>HTTPS</b> — every connection to a bank, broker, Gmail, or "
      "Anthropic is encrypted in transit by the browser. This is standard "
      "everywhere; we get it for free.", story)
    P("Layer 2: <b>SQLCipher (AES-256-CBC + HMAC-SHA512)</b> — encrypts the entire "
      "vault.db file at rest. Key = Argon2id(master_password, salt).", story)
    P("Layer 3: <b>Field encryption (AES-256-GCM)</b> — encrypts individual "
      "sensitive columns within the database. Key = random 32 bytes in keychain.", story)

    H2("6.3 Where each key lives", story)
    TABLE([
        ["Key", "Derived from", "Stored at", "Used to"],
        ["Master key (32 bytes)",
         "Argon2id(password, salt)",
         "Never stored — in memory only while vault is unlocked",
         "Open the SQLCipher DB"],
        ["Field key (32 bytes)",
         "Random when first generated",
         "OS keychain (keytar)",
         "AES-GCM encrypt/decrypt sensitive columns"],
        ["Argon2 salt (16 bytes)",
         "Random when vault first created",
         "vault.meta.json (plaintext)",
         "Reproduce the master key from the password"],
        ["Backup field-key.bin",
         "Field key AES-GCM-encrypted with master key",
         "Inside each snapshot folder",
         "Restore the field key on another machine"],
    ], story, col_widths=[3.5*cm, 4.0*cm, 5.5*cm, 4.0*cm])

    H2("6.4 Threat model — who are we protecting against?", story)
    P("\"Threat model\" is the question: <i>what kinds of attackers do we worry "
      "about, and what can each one realistically do?</i> Listed from weakest to "
      "strongest:", story)

    H3("Threat 1: Casual snoop with brief physical access", story)
    P("Someone glances at your unlocked PC for 30 seconds while you are at lunch. "
      "What they can see depends on whether the vault is locked:", story)
    B([
        "<b>If locked</b>: nothing — they see the unlock screen.",
        "<b>If unlocked</b>: anything currently on screen — the family list, the "
        "active modals. They could click around the UI but every credential is "
        "either masked (passwords show as bullets) or only revealed by clicking "
        "(detail card cells). They cannot copy out the vault file in 30 seconds.",
    ], story)
    P("<b>Mitigation:</b> Ctrl+L locks immediately. Auto-lock after 30 minutes "
      "idle. Train yourself to hit Ctrl+L when stepping away.", story)

    H3("Threat 2: Persistent local user (e.g. office IT, family member)", story)
    P("Someone with the same Windows account, or admin rights on your PC. They "
      "have hours of access. Without the master password they:", story)
    B([
        "Can find vault.db in %APPDATA% (yes — it's just a file).",
        "Cannot read it (SQLCipher).",
        "Could try to brute-force the master password — but Argon2id makes "
        "this 5+ days per million tries on a decent CPU; a strong password "
        "is effectively safe.",
        "<b>Can read browser session cookies</b> in the browser-profiles folder "
        "— this would let them replay a bank login. <b>This is the most "
        "serious risk</b>, mitigated by the lock-time browser session purge.",
    ], story)

    H3("Threat 3: Stolen disk (lost laptop, sold hard drive)", story)
    P("Worst-case offline attack: an attacker has the entire disk image, all "
      "the time in the world. With a strong master password and Argon2id "
      "parameters, this is effectively safe — but no encryption survives a "
      "guess of \"password\" or \"akshay123\". <b>The master password is the "
      "weakest link.</b> Use 16+ characters with mixed case, digits, symbols, "
      "and no dictionary words.", story)

    H3("Threat 4: Malware running as you", story)
    P("If a virus is running as your Windows user, it has the same rights you "
      "do — including access to the OS keychain. Nothing the app can do prevents "
      "this. Mitigations: keep Windows Defender on, do not install random "
      ".exe files, do not click email attachments from strangers.", story)

    H3("Threat 5: A targeted attack by a nation-state", story)
    P("Outside the design scope of this app. If a state actor wants your data, "
      "they will get it through other means (compromising the Anthropic API "
      "endpoint, intercepting OTPs at the carrier, etc.).", story)

    H2("6.5 What we DO protect against", story)
    B([
        "Theft of the laptop / disk → AES-256 encryption is unbroken in any "
        "remotely-practical time.",
        "Casual access during a lunch break → manual lock, auto-lock, password "
        "masking in UI.",
        "Cloud-account compromise → there is no cloud account; data never leaves "
        "the local PC except for the user-chosen backup folder.",
        "Credential leak from a third-party service → no third-party service has "
        "your credentials.",
    ], story)

    H2("6.6 What we DON'T protect against", story)
    B([
        "Weak master password (this is on you).",
        "Malware running as you (this is on Windows Defender).",
        "A coerced unlock (someone forcing you to type the password — encryption "
        "fundamentally can't help here).",
        "A breach of Anthropic or Google (we send some metadata to both — see 6.7).",
    ], story)

    H2("6.7 What leaves the machine — explicitly listed", story)
    P("Things that go off-disk in normal use:", story)
    B([
        "<b>To bank/broker websites:</b> your credentials. This is the entire point.",
        "<b>To Gmail:</b> the queries to read OTP emails. Gmail already had those "
        "emails — we just read them.",
        "<b>To Anthropic (api.anthropic.com):</b> the AU Bank CAPTCHA image, "
        "ONLY when AU login is in progress AND consent is recorded AND daily "
        "cap not reached. ~4 KB per image.",
        "<b>To BSE / NSE:</b> requests for the public IPO catalog. No "
        "personally-identifiable data.",
        "<b>To your chosen backup folder (OneDrive/Drive/Dropbox if used):</b> "
        "encrypted snapshots. The cloud provider sees encrypted blobs, not "
        "your credentials.",
    ], story)
    P("Things that <b>never</b> leave the machine:", story)
    B([
        "Your master password (it is hashed locally, never transmitted).",
        "The decrypted credentials themselves.",
        "The audit log.",
        "Anything in vault.db.",
    ], story)


# ─────────────────────────────────────────────────────────────────────────────
# Part 7 — Features
# ─────────────────────────────────────────────────────────────────────────────

def section_part7_features(story):
    H1("Part 7 — Features: What Works", story)

    H2("7.1 Vault setup and unlock", story)
    P("<b>First-time setup:</b> on the first launch, the app asks you to create a "
      "master password. You type it, confirm it, click \"Create vault\". The app:", story)
    B([
        "Validates password strength (≥12 chars, mixed case, digit, symbol, no common words).",
        "Generates a random 16-byte salt.",
        "Writes vault.meta.json.",
        "Derives the master key (Argon2id, ~500ms).",
        "Creates vault.db with the schema embedded in schema.ts.",
        "Generates a random 32-byte field key, stores it in OS keychain.",
        "Transitions to the dashboard (empty — no families yet).",
    ], story)
    P("<b>Subsequent unlocks:</b> type the password, hit Unlock, see the 1.8-second "
      "splash, land on your data.", story)

    H2("7.2 Family and member management", story)
    P("Click \"+ Family\" in the sidebar to add a family. Set a minimum-balance "
      "threshold (for the Balance Management dashboard).", story)
    P("Click \"+ Member\" inside a family to add a member. Enter name, PAN, Aadhaar, "
      "DOB, mobile, email, email password. Add bank accounts (user-id, password, "
      "customer-id, account number, IFSC). Add broker accounts (user-id, password, "
      "client-id, TOTP secret if used). Upload document softcopies (PAN PDF, Aadhaar, "
      "cancelled cheque).", story)
    P("Drag-and-drop reorder works both at family level (sidebar) and member level "
      "(within a family).", story)

    H2("7.3 Bank login automation", story)
    P("Per bank, the app implements the full login flow: navigate to the bank's "
      "login page, fill credentials, fetch OTP from Gmail (or use TOTP), solve "
      "CAPTCHA via Claude (AU Bank only), land on the dashboard, scrape the "
      "balance, update the DB.", story)
    P("Supported banks (9): AU, YES, SBI, KOTAK, ICICI, BOB, PNB, HDFC, AXIS.", story)
    P("The browser window stays open after login so you can do anything else "
      "manually if you want.", story)

    H2("7.4 Broker login + portfolio fetch", story)
    P("Same pattern for brokers (7): Zerodha, Dhan, Angel One, Mirae, Shoonya, "
      "Fyers, Groww.", story)
    P("For Zerodha / Dhan / Angel, the app can also download the holdings Excel "
      "report and parse it into structured rows (broker_portfolio_reports + "
      "broker_portfolio_holdings tables). The parsed data drives the portfolio "
      "view modal.", story)

    H2("7.5 AU Bank IPO bidding", story)
    P("This is the headline feature. From the All Members header → AU IPO dropdown:", story)
    B([
        "Tick individual members or whole families via the indeterminate-checkbox.",
        "Pick an issue from the BSE catalog (cached locally, refreshed on demand).",
        "Enter quantity (in lots) and bid type (CUTOFF or LIMIT).",
        "Click Open AU & Prepare — the app logs into AU for each member in sequence, "
        "fills the bid, screenshots it for review.",
        "Confirm or Cancel each one. Only Confirmed bids are actually submitted.",
        "Each submitted bid is recorded in ipo_bid_runs with bank reference number.",
    ], story)

    H2("7.6 Excel import / export", story)
    P("Import: parse a Demat_Sheet.xlsx where each sheet is one family and each "
      "column is one member. Used for the initial bulk load from your existing "
      "records. Schema documented inline in src/main/importer/excel.ts.", story)
    P("Export: produce a plaintext Excel copy of the vault for human review or "
      "external backup. Requires the master password to be currently in memory "
      "(i.e. vault unlocked).", story)

    H2("7.7 Encrypted incremental backup", story)
    P("Choose a backup folder (ideally inside OneDrive/Drive for multi-machine "
      "sync). The engine:", story)
    B([
        "Creates a snapshot 10s after unlock and every 6h thereafter.",
        "Each snapshot includes a consistent SQLCipher-encrypted DB copy "
        "(via VACUUM INTO), vault.meta.json (salt for cross-machine restore), "
        "and field-key.bin (field key encrypted with the master key).",
        "Document files (PDFs/JPEGs) live in a shared content-addressed "
        "blobs/ folder — same file referenced from many snapshots is stored "
        "ONCE.",
        "Retention bands: keep ALL in last 24h, ONE per day in last 7d, ONE "
        "per week in last 30d, ONE per month in last 6mo.",
        "Garbage collection removes blobs no surviving snapshot references.",
    ], story)
    P("Restore: pick a snapshot, type the master password. Engine re-derives the "
      "key from the snapshot's own salt — so the same password works across "
      "machines even though they have different local salts.", story)

    H2("7.8 Member detail card (the credentials cockpit)", story)
    P("Click any member's name → modal opens with compact tables:", story)
    B([
        "Identity (Name / PAN / Aadhaar / DOB / Mobile / Email / Email Password)",
        "Banks (one row per configured bank: User ID / Password / Customer ID / "
        "Account No. / IFSC)",
        "Brokers (one row per configured broker: User ID / Password / Client ID / "
        "TOTP / Mobile / Email)",
    ], story)
    P("Click any cell → copies the raw value to the clipboard. Secrets are masked "
      "in the display (•••••) but the clipboard gets the real text.", story)

    H2("7.9 Spreadsheet view", story)
    P("New top-level view in the sidebar nav: a flat sortable, filterable grid of "
      "all members × all banks/brokers. Rows = members, columns = each configured "
      "bank's balance + each configured broker's portfolio value + totals.", story)
    P("Search by name/family/mobile/email. Filter by family. Sort by any column. "
      "Click a member name → opens the detail card.", story)

    H2("7.10 Cost-safety guardrails for CAPTCHA solving", story)
    B([
        "<b>Daily call cap</b> (default 100) — refuses calls past the cap with a "
        "clear log line.",
        "<b>Consent flag</b> — must be ticked before any CAPTCHA image is uploaded "
        "(auto-flipped when you save the Anthropic key).",
        "<b>Per-day token tracking</b> — input + output token counts.",
        "<b>Sidebar pill</b> shows today's count: e.g. CAPTCHA AI: Claude ready (3/100)",
    ], story)

    H2("7.11 Manual lock + Ctrl+L", story)
    P("🔒 Lock button in the sidebar header. Ctrl+L global shortcut. Locks the DB, "
      "wipes in-memory secrets, purges browser sessions, returns to unlock screen.", story)

    H2("7.12 Factory reset", story)
    P("Backup Settings → Danger zone → \"Reset everything…\" Type RESET to "
      "confirm. Wipes the entire data directory, browser profiles, and keychain "
      "entries. Backup folder is untouched.", story)


# ─────────────────────────────────────────────────────────────────────────────
# Part 8 — Limitations
# ─────────────────────────────────────────────────────────────────────────────

def section_part8_limitations(story):
    H1("Part 8 — Limitations and Known Issues", story)

    H2("8.1 Selector brittleness — websites change", story)
    P("Every adapter (auBank.ts, sbiBank.ts, etc.) clicks buttons and fills inputs "
      "by addressing elements on the bank's webpage using <i>selectors</i> — "
      "patterns like \"the input with placeholder='User ID'\" or "
      "\"the button containing the text 'Login'\".", story)
    P("When the bank redesigns their website (which happens every 6–18 months), "
      "those selectors break. Symptoms: the automation hits a timeout, or types "
      "into the wrong field, or never clicks the right button.", story)
    P("<b>Workaround:</b> open the bank's site manually, inspect the new HTML, "
      "update the selectors in the corresponding adapter file. There is no "
      "automated way around this — it is an inherent cost of website automation.", story)

    H2("8.2 Only AU IPO bidding is automated", story)
    P("The full IPO bid flow (prepare → review → submit) is only implemented for "
      "AU Bank. Other banks support login + balance fetch but not IPO bidding. "
      "Adding more banks requires writing each bank's prepareIpoBid + "
      "submitPreparedIpoBid functions — non-trivial because every bank's IPO page "
      "is different.", story)

    H2("8.3 No allotment tracking", story)
    P("After the IPO closes, you have to check allotment status manually (via "
      "BSE/NSE/registrar websites). The app does not yet automate this.", story)

    H2("8.4 No auto-bid scheduler", story)
    P("You have to be at your desk during the IPO open window to click \"Open AU "
      "& Prepare\". A future feature: schedule bids to fire at 10:01 AM on Day 1.", story)

    H2("8.5 No mobile app", story)
    P("Windows desktop only. No mobile or web version. Multi-machine support is "
      "via backup folder sync (OneDrive/Drive), not via real-time sync.", story)

    H2("8.6 Browser-dependent", story)
    P("Requires Google Chrome or Microsoft Edge installed on the machine. The "
      "automation cannot use Firefox in the current configuration. Most Windows "
      "users already have Chrome or Edge, so this is rarely a real obstacle.", story)

    H2("8.7 No code signing", story)
    P("When the recipient runs the installer on a fresh PC, Windows SmartScreen "
      "shows \"Windows protected your PC — unrecognized app\". They have to click "
      "\"More info → Run anyway\". This is because we are not paying for a code "
      "signing certificate (~₹15,000/yr). Functionally harmless but looks "
      "intimidating to first-time users.", story)

    H2("8.8 No auto-update", story)
    P("To deliver a new build, you have to send the installer file again (or share "
      "a download link). The current app does not check for updates on startup. "
      "Future: wire up electron-updater.", story)

    H2("8.9 Logs grow unbounded", story)
    P("automation.log appends forever, no rotation. After many months it could be "
      "hundreds of MB. Plan: rotate at 5 MB or daily, keep last 10 files. Tracked "
      "as a yellow audit item.", story)

    H2("8.10 No DB indexes on some columns", story)
    P("The holdings, ipo_applications, documents.doc_type, bank_accounts.bank_code, "
      "and broker_accounts.broker_code columns are not indexed. For your current "
      "data size (~35 members, ~250 accounts) this is invisible. At 1000+ accounts "
      "queries would slow down. Easy fix when needed.", story)


# ─────────────────────────────────────────────────────────────────────────────
# Part 9 — Risks
# ─────────────────────────────────────────────────────────────────────────────

def section_part9_risks(story):
    H1("Part 9 — Security Risks — Current Posture", story)

    H2("9.1 Critical risks — now mitigated", story)
    TABLE([
        ["Risk", "Mitigation"],
        ["Vault file lost or corrupted", "Encrypted incremental backup engine with retention bands and multi-machine restore."],
        ["Browser cookies replayable", "Profile purge on every lock (manual + auto-lock) + manual button."],
        ["Anthropic API spend runaway", "Daily call cap, token tracking, consent flag, per-call gate."],
        ["No way to lock vault on demand", "Ctrl+L + sidebar Lock button + auto-lock at 30 min idle."],
        ["No tests on security-critical paths", "18 vitest tests covering Argon2 round-trip, AES-GCM tamper detection, key sensitivity to salt + password."],
    ], story, col_widths=[6.5*cm, 10.5*cm])

    H2("9.2 Remaining risks (yellow, not red)", story)
    TABLE([
        ["Risk", "Mitigation status / next step"],
        ["Weak master password", "Strength check in master.ts (12+ chars, mixed). Could upgrade to zxcvbn library."],
        ["Malware on user's PC", "Outside app scope — relies on Windows Defender."],
        ["Audit log accumulates forever", "Inserts done; UI to view + retention not yet built."],
        ["No clipboard auto-clear after copy", "Member detail card copies value to clipboard; stays there until you copy something else. Plan: 30-second auto-clear."],
        ["No code signing on installer", "Cost ~₹15,000/year. Visible only as a SmartScreen warning, no functional impact."],
        ["No auto-update", "Manual reinstall. Plan: electron-updater with a private S3 release bucket."],
    ], story, col_widths=[6.5*cm, 10.5*cm])

    H2("9.3 What could go wrong — failure scenarios", story)

    H3("Scenario: \"I forgot my master password\"", story)
    P("There is no recovery. We deliberately do not have a recovery mechanism — "
      "that would defeat the encryption. <b>Mitigation:</b> write the master "
      "password on paper, store it in your office safe.", story)

    H3("Scenario: \"My laptop hard drive died\"", story)
    P("If you had backups configured (Backup Settings → folder inside OneDrive/Drive), "
      "you can install the app on a new machine and restore from the cloud-synced "
      "snapshot folder. Recovery time: ~15 minutes. <b>Mitigation:</b> configure "
      "backups to a cloud-synced folder.", story)

    H3("Scenario: \"A bank changes its login flow\"", story)
    P("The adapter for that bank breaks. You see a timeout error in the toast. "
      "<b>Workaround:</b> open the bank manually for now; ping for an adapter "
      "update.", story)

    H3("Scenario: \"My OneDrive backup folder gets deleted\"", story)
    P("OneDrive (and Drive, Dropbox) keep deleted files in their Recycle Bin for "
      "30 days. Restore from there. <b>Mitigation:</b> if super-paranoid, configure "
      "TWO backup folders — one cloud, one local on a different physical drive.", story)

    H3("Scenario: \"Someone steals my laptop\"", story)
    P("With a strong master password (16+ chars, no dictionary words), the vault "
      "is mathematically safe — they'd need years to brute-force Argon2id. "
      "Lock immediately. <b>Mitigation:</b> change passwords on the most critical "
      "banks within 24 hours anyway, just to be safe (the attacker might extract "
      "session cookies before you can wipe the drive remotely).", story)


# ─────────────────────────────────────────────────────────────────────────────
# Part 10 — One click, end to end
# ─────────────────────────────────────────────────────────────────────────────

def section_part10_one_click(story):
    H1("Part 10 — One Click, End to End", story)
    P("To make all the abstract concepts concrete, let's follow a single user "
      "action through every file and function it touches.", story)
    P("<b>The action:</b> you click \"Refresh AU\" next to Akshay Sharma's name "
      "in the All Members view.", story)

    H2("Step 1: The click is dispatched in React", story)
    P("In Dashboard.tsx, the AU bank chip is rendered inside a member row. The "
      "button has an onClick handler:", story)
    CODE("""<button
  className="account-name-button bank-name-button"
  onClick={() => loginBank(m.id, bank, family.id, { fetchBalance: true })}>
  AU
</button>""", story)
    P("When you click, React fires the handler. The handler is loginBank() — a "
      "function defined elsewhere in Dashboard.tsx.", story)

    H2("Step 2: loginBank() prepares the IPC call", story)
    CODE("""async function loginBank(memberId, bank, familyId, opts) {
  setBusy(`bank-${bank.id}`);                  // show spinner on this chip
  showToast('info', `Refreshing ${bank.bank_code}...`);

  try {
    const result = await window.api.login.bank(  // <- IPC call to main
      memberId, bank.id, { closeAfterFetch: false }
    );
    if (result.ok) {
      showToast('success', `${bank.bank_code} refreshed`);
      patchBankResult(memberId, bank, familyId, result);
    } else {
      showToast('error', `${bank.bank_code}: ${result.error}`);
    }
  } finally {
    setBusy(null);                              // hide spinner
  }
}""", story)

    H2("Step 3: The preload bridge", story)
    P("window.api.login.bank() is defined in src/preload/index.ts:", story)
    CODE("""login: {
  bank: (memberId, bankId, options) =>
    ipcRenderer.invoke('login:bank', { memberId, bankId, closeAfterFetch: !!options?.closeAfterFetch })
}""", story)
    P("This sends an IPC message to the main process with the channel name "
      "'login:bank' and the payload.", story)

    H2("Step 4: Main process receives the message", story)
    P("In src/main/ipc.ts:", story)
    CODE("""ipc.handle('login:bank', async (_, payload) => {
  return runLogin('BANK', payload.memberId, payload.bankId, {
    fetchBalance: true,
    closeAfterFetch: payload.closeAfterFetch ?? false,
  });
});""", story)
    P("runLogin is a generic function used for both banks and brokers. Let me walk "
      "through what it does.", story)

    H2("Step 5: runLogin loads credentials from the database", story)
    CODE("""async function runLogin(kind, memberId, accountId, options) {
  const db = getDb();
  const account = db.prepare(
    'SELECT * FROM bank_accounts WHERE id = ? AND member_id = ?'
  ).get(accountId, memberId);

  if (!account) return { ok: false, error: 'Account not found' };

  const code = account.bank_code;             // 'AU'
  const adapter = getBankAdapter(code);        // auBankAdapter
  if (!adapter) return { ok: false, error: `No adapter for ${code}` };

  const username = await decryptField(account.user_id_enc);
  const password = await decryptField(account.password_enc);
  const customerId = await decryptField(account.customer_id_enc);
  // ...""", story)

    H2("Step 6: launchSession opens a real Chromium window", story)
    CODE("""const { context, page } = await launchSession({
  profileKey: 'BANK-AU-42'                  // unique per (kind, code, member)
});""", story)
    P("If a previous session for this profile is cached, it is reused (cookies "
      "still valid → skips the login). Otherwise launches a fresh Chromium "
      "instance with a persistent profile.", story)

    H2("Step 7: The adapter runs the actual login", story)
    P("In src/main/automation/auBank.ts:", story)
    CODE("""async function login(page, creds, fetchOtp) {
  await page.goto('https://retail.aubank.in/...', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name=\"customerid\"]', creds.customerId);
  await page.click('button:has-text(\"Proceed\")');
  await page.fill('input[type=\"password\"]', creds.password);

  // Solve CAPTCHA
  const captchaImg = await page.locator('img.captcha').screenshot();
  const captchaText = await solveCaptchaTextWithClaude(captchaImg);
  await page.fill('input[name=\"captcha\"]', captchaText);

  await page.click('button:has-text(\"Login\")');

  // Wait for OTP screen, fetch OTP from Gmail
  await page.waitForSelector('input[name=\"otp\"]');
  const otp = await fetchOtp();
  await page.fill('input[name=\"otp\"]', otp);
  await page.click('button:has-text(\"Submit\")');

  // Wait for dashboard
  await page.waitForURL(/dashboard/, { timeout: 30000 });
}""", story)

    H2("Step 8: Balance is fetched", story)
    CODE("""const balance = await adapter.fetchBalance(page);
// e.g. 'Savings: ₹8,141.37 | Deposit: ₹2,00,000.00'

db.prepare('UPDATE bank_accounts SET balance = ?, balance_fetched_at = CURRENT_TIMESTAMP WHERE id = ?')
  .run(balance, accountId);""", story)

    H2("Step 9: Audit log is written", story)
    CODE("""auditInsert.run(memberId, 'LOGIN_BANK', 'AU', 'SUCCESS', `balance:${balance}`);""", story)

    H2("Step 10: Return to renderer", story)
    CODE("""return { ok: true, balance, balanceFetchedAt: new Date().toISOString() };""", story)
    P("The result travels back through the IPC bridge, through preload, into the "
      "awaiting promise inside loginBank(), which then updates the UI.", story)

    H2("Step 11: UI updates", story)
    P("patchBankResult() (still inside Dashboard.tsx) updates the React state, "
      "which causes the AU chip to re-render with the new balance string. The "
      "toast 'AU refreshed' appears in the bottom-right.", story)

    P("Total elapsed time: 8–15 seconds (depending on bank speed and CAPTCHA difficulty). "
      "Files touched: 7 different .ts files across renderer, preload, and main. "
      "Libraries used: React (for the click), Electron (for IPC), Playwright (for "
      "the browser), better-sqlite3-multiple-ciphers (for the DB), keytar (via field "
      "decryption), googleapis (for OTP), Anthropic (for CAPTCHA).", story)


# ─────────────────────────────────────────────────────────────────────────────
# Part 11 — Glossary
# ─────────────────────────────────────────────────────────────────────────────

def section_part11_glossary(story):
    H1("Part 11 — Glossary", story)

    glossary = [
        ("Adapter",
         "A self-contained module that knows how to log into one specific bank or broker. Each adapter implements the LoginAdapter interface (login, fetchBalance, optional downloadPortfolioReport, prepareIpoBid, submitPreparedIpoBid)."),
        ("AES-256-GCM",
         "A symmetric encryption algorithm. AES = the cipher. 256 = key size in bits. GCM = Galois/Counter Mode, which provides both confidentiality (encryption) and integrity (the auth tag detects tampering). Industry-standard modern choice."),
        ("Argon2id",
         "The winner of the 2015 Password Hashing Competition. Slow and memory-hard by design — making brute-force expensive even with GPUs."),
        ("asar",
         "Electron's way of packing many small files into one archive for faster loading. The app.asar file inside dist/win-unpacked/resources/ is your compiled code. Files unsafe for asar (native modules, browser binaries) live in app.asar.unpacked alongside."),
        ("CAPTCHA",
         "Completely Automated Public Turing test to tell Computers and Humans Apart — those squiggly-letter images banks show to slow down automation. AU Bank uses one; we solve it with Anthropic Claude."),
        ("Chromium",
         "The open-source web browser engine that Chrome, Edge, Brave, and Electron all use to render web pages."),
        ("Electron",
         "A framework that bundles Chromium + Node.js to build desktop apps with web technologies."),
        ("Frontend / Backend",
         "Frontend = the visible UI (what you see). Backend = the invisible logic (what does the work)."),
        ("HTTPS",
         "HTTP over TLS — the encrypted version of the protocol your browser uses. Every bank URL starting with https:// is encrypted in transit."),
        ("IPC (Inter-Process Communication)",
         "Messaging between two separate processes. In Electron, the renderer and main processes use IPC to talk."),
        ("Library / Package / Module",
         "Three nearly-synonymous terms for pre-written code you import. In JavaScript-land, all three are typically called 'packages' and live in node_modules/."),
        ("Main process",
         "The Node.js process that runs the backend logic in Electron. Has full file system / OS access. Lives in src/main/."),
        ("Migration",
         "A script that updates an existing database to a new schema version (e.g. adds a new column). Designed to be idempotent — running twice has the same effect as running once."),
        ("Node.js",
         "JavaScript running outside the browser. Used everywhere on the backend."),
        ("npm",
         "Node Package Manager — the standard tool for installing and managing JavaScript libraries. The package.json file is npm's manifest."),
        ("OAuth",
         "An authentication protocol that lets you grant a third-party app access to your account on another service (e.g. Gmail) without giving away your password. The protocol issues a 'refresh token' that the app stores."),
        ("OTP",
         "One-Time Password — a 6-digit code sent to your phone or email, valid for a few minutes. Used as a second factor by most banks."),
        ("Playwright",
         "A modern browser-automation library that drives Chrome, Firefox, or Safari from your code."),
        ("Preload",
         "A small script that runs in the renderer process before the page loads, but with access to Node APIs. Used to expose a controlled subset of main-process functions to the renderer (via window.api)."),
        ("React",
         "A JavaScript library for building component-based UIs. State changes automatically trigger re-renders."),
        ("Renderer process",
         "The Chromium browser tab inside Electron that shows the UI. Sandboxed — cannot directly access the file system. Talks to main via IPC."),
        ("Salt",
         "A random value mixed with the password before hashing. Prevents 'rainbow table' attacks. Stored alongside the hashed key — not secret, but essential for reproducing the same key."),
        ("SQLCipher",
         "An extension to SQLite that encrypts every page of the database file at rest using AES-256-CBC + HMAC-SHA512. Used here via better-sqlite3-multiple-ciphers."),
        ("SQLite",
         "A self-contained file-based database — no server, no network. The whole DB is one .db file."),
        ("TOTP",
         "Time-Based One-Time Password — like an OTP but generated locally on your device from a shared secret + the current time. Used by Google Authenticator and broker logins like Zerodha."),
        ("TypeScript",
         "JavaScript plus type annotations. Catches type errors at build time. Every .ts file in this project is TypeScript."),
        ("Vite",
         "A modern build tool that compiles TypeScript and bundles JavaScript modules. Used by electron-vite for the three-part Electron build."),
        ("Vault",
         "Our term for the entire encrypted-data set on disk: vault.db + vault.meta.json + documents/."),
    ]

    for term, defn in glossary:
        story.append(Paragraph(
            f"<b>{term}</b> — {defn}",
            ParagraphStyle('Term', parent=style_body, leftIndent=10,
                           spaceAfter=6, fontSize=10, leading=14)
        ))


# ─────────────────────────────────────────────────────────────────────────────
# Appendices
# ─────────────────────────────────────────────────────────────────────────────

def section_appendix_a(story):
    H1("Appendix A — Command Cheat Sheet", story)

    H2("Building", story)
    CODE("""npm install                # download dependencies (~5 min first time)
npm run dev                # run app in development mode (hot-reload)
npm run build              # compile TS to JS in out/
npm run build:win          # build + produce Windows installer in dist/
npm test                   # run the test suite
npm run test:watch         # watch mode for test development""", story)

    H2("Backup folder management", story)
    CODE("""# Default vault location
%APPDATA%\\ipo-manager\\data\\

# Files in there:
  vault.db                # encrypted SQLite database
  vault.meta.json         # Argon2 salt + params (not secret)
  documents/              # encrypted document blobs
  logs/                   # automation.log + screenshots
  backup.config.json      # your chosen backup folder
  backup.state.json       # last backup timestamp

# To completely wipe everything (in the app):
#   Backup Settings  →  Danger zone  →  "Reset everything..."

# To wipe manually (outside the app):
del /S /Q "%APPDATA%\\ipo-manager"
# Then go to Credential Manager and delete the three 'ipo-manager' entries.""", story)

    H2("Inspecting the vault file", story)
    CODE("""# The vault file is encrypted — it looks like random bytes without
# the master password.

# To see something:
sqlite3 "%APPDATA%\\ipo-manager\\data\\vault.db" ".tables"
# Result: Error: file is not a database  (because SQLCipher rejects it)

# With the right SQLCipher tool and your master password, you can
# inspect it — but normally you should never need to.""", story)

    H2("Diagnosing automation failures", story)
    CODE("""# automation.log lives in:
%APPDATA%\\ipo-manager\\data\\logs\\automation.log

# Tail the log while running:
type "%APPDATA%\\ipo-manager\\data\\logs\\automation.log"

# Look for lines like:
#   [2026-05-20T10:23:45.123Z] [AU_LOGIN] Filled customer id
#   [2026-05-20T10:23:46.456Z] [AU_CAPTCHA] Anthropic raw response: "d3h31d"
#   [2026-05-20T10:23:48.789Z] [AU_LOGIN] OTP received from Gmail""", story)


def section_appendix_b(story):
    H1("Appendix B — Troubleshooting", story)

    H2("Symptom: \"Wrong password\" after typing correctly", story)
    P("Check that Caps Lock is off (passwords are case-sensitive). If you restored "
      "a backup recently, make sure you typed the SAME password the backup was "
      "created with — not a different one you used on this machine.", story)

    H2("Symptom: Clicking a bank does nothing", story)
    P("Check the toast in the bottom-right. Possibilities:", story)
    B([
        "<b>\"No adapter for X\"</b> → the bank code stored is wrong (e.g. ANGELONE instead of ANGEL). Fix via Edit Member.",
        "<b>\"Missing credentials\"</b> → user_id or password is empty for this account. Fix via Edit Member.",
        "<b>\"Could not open browser\"</b> → Chrome/Edge not found on the machine. Install Chrome.",
        "<b>Nothing visible</b> → check automation.log for the actual error.",
    ], story)

    H2("Symptom: CAPTCHA solving keeps failing", story)
    B([
        "Check the CAPTCHA AI pill — does it say \"ready\"?",
        "Open the modal and check: is consent checked? Is today's count under the cap?",
        "Check automation.log for \"Claude solve skipped: ...\".",
        "Try clicking again — AU's CAPTCHA is randomly hard sometimes; second try often works.",
    ], story)

    H2("Symptom: Backup pill is yellow or red", story)
    B([
        "Open Backup Settings.",
        "Yellow = last backup 24-72h ago. Click \"Backup Now\".",
        "Red = >72h ago, or the auto-backup is hitting an error. Check the \"Last error\" field.",
    ], story)

    H2("Symptom: \"Could not decrypt the field key with the master password\" when restoring", story)
    P("This was a bug in the original backup engine. Make sure you are running "
      "build version after 2026-05-19 — the latest installer fixes this by "
      "including vault.meta.json (the salt) in every snapshot.", story)

    H2("Symptom: App is very slow to start", story)
    P("First-launch slowness is normal — Argon2 takes ~500ms by design, and "
      "Windows Defender scans the unsigned executable on first run. Subsequent "
      "launches should be under 2 seconds plus the splash duration (1.8s).", story)

    H2("Where to ask for help", story)
    P("If the toast or log doesn't make the failure obvious, copy the log file "
      "(automation.log, last 200 lines) and send it to the developer along with "
      "a description of what you were trying to do.", story)


# ─────────────────────────────────────────────────────────────────────────────
# Closing matter
# ─────────────────────────────────────────────────────────────────────────────

def section_closing(story):
    H1("Closing Note", story)
    P("If you have read this far — really read, not just skimmed — you now "
      "understand more about how a modern Electron desktop app is structured "
      "than most working programmers do. You know:", story)
    B([
        "What the three layers of a desktop app are and which folder holds each.",
        "How Argon2id turns a password into a key, and why that matters.",
        "How Playwright drives a real Chrome window to log into banks.",
        "Why salt belongs in every backup snapshot.",
        "What CAPTCHA, OAuth, IPC, AES-GCM, TOTP mean and how they fit together.",
    ], story)
    P("The biggest takeaway: software architecture is mostly about <i>making the "
      "right separations</i>. Renderer vs main. Identity vs credentials. Master key "
      "vs field key. Configuration vs data vs code. Each separation is a deliberate "
      "choice that protects something or makes something easier to change later.", story)
    P("When you get stuck reading the code, ask the AI:", story)
    B([
        "\"What does this file do?\" — start with a one-paragraph summary.",
        "\"What is the data flow from X to Y?\" — ask for a step-by-step trace.",
        "\"What are the failure modes of this function?\" — ask for what could go wrong.",
        "\"Show me the simplest possible test for this.\" — get a concrete example.",
    ], story)
    P("That is the same way I learned everything in this codebase. The pattern works.", story)
    SP(6, story)
    P("Built with care for you, bhai. May your IPOs be allotted and your "
      "balances always above the minimum threshold.", story)


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def section_part12_add_bank(story):
    H1("Part 12 — How to Add a New Bank Adapter", story)
    P("Suppose you want to add support for IDFC First Bank. Here is the full "
      "walk-through. This is the kind of task that, once you have done it once, "
      "is repeatable in an hour.", story)

    H2("12.1 Pick a code", story)
    P("Every bank has a short uppercase code throughout the codebase: AU, YES, "
      "SBI, etc. Pick one for the new bank. For IDFC First, IDFC is the obvious "
      "choice.", story)

    H2("12.2 Create the adapter file", story)
    P("Copy <font face='Courier'>src/main/automation/genericBank.ts</font> to "
      "<font face='Courier'>src/main/automation/idfcBank.ts</font>. This gives "
      "you the boilerplate structure:", story)
    CODE("""import { Page } from 'playwright';
import { LoginAdapter, LoginCredentials } from './browser';

const LOGIN_URL = 'https://my.idfcfirstbank.com/login';

export const idfcBankAdapter: LoginAdapter = {
  code: 'IDFC',
  displayName: 'IDFC First Bank',
  otpMode: 'email',  // or 'manual' if user must enter SMS OTP themselves

  async login(page, creds, fetchOtp) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    // ... real login logic goes here
  },

  async fetchBalance(page) {
    // ... scrape balance from the dashboard
    return null;
  },
};""", story)

    H2("12.3 Inspect the real bank's login flow", story)
    P("Open the IDFC site in your normal Chrome. Right-click the user-id field "
      "→ Inspect. Note the selector — does it have an id? a name? an aria-label? "
      "a unique placeholder?", story)
    P("Write down each step:", story)
    B([
        "Step 1 — User ID field. Selector: <font face='Courier'>input[name=\"userid\"]</font>",
        "Step 2 — Continue button. Selector: <font face='Courier'>button:has-text(\"Continue\")</font>",
        "Step 3 — Password field. Selector: <font face='Courier'>input[type=\"password\"]</font>",
        "Step 4 — Maybe a security image confirmation step.",
        "Step 5 — Login button. Then OTP screen.",
        "Step 6 — OTP input field.",
        "Step 7 — Dashboard URL pattern to wait for.",
    ], story)

    H2("12.4 Implement login() step by step", story)
    CODE("""async login(page, creds, fetchOtp) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  // Step 1: User ID
  await page.fill('input[name=\"userid\"]', creds.username);
  await page.click('button:has-text(\"Continue\")');

  // Step 2: Password
  await page.waitForSelector('input[type=\"password\"]', { timeout: 15_000 });
  await page.fill('input[type=\"password\"]', creds.password);
  await page.click('button:has-text(\"Login\")');

  // Step 3: OTP from Gmail
  await page.waitForSelector('input[name=\"otp\"]', { timeout: 30_000 });
  const otp = await fetchOtp();
  await page.fill('input[name=\"otp\"]', otp);
  await page.click('button:has-text(\"Submit\")');

  // Step 4: Wait for dashboard
  await page.waitForURL(/dashboard/, { timeout: 30_000 });
}""", story)

    H2("12.5 Implement fetchBalance()", story)
    P("On the dashboard, find the savings balance display. Right-click → Inspect. "
      "Often it has a unique class like <font face='Courier'>.balance-value</font>. Then:", story)
    CODE("""async fetchBalance(page) {
  const txt = await page.locator('.balance-value').first().textContent();
  return txt ? txt.trim() : null;
}""", story)

    H2("12.6 Register the adapter", story)
    P("Open <font face='Courier'>src/main/automation/registry.ts</font> and add:", story)
    CODE("""import { idfcBankAdapter } from './idfcBank';

const BANK_ADAPTERS = {
  AU:    auBankAdapter,
  // ... existing banks ...
  IDFC:  idfcBankAdapter,
};""", story)

    H2("12.7 Add the OTP query", story)
    P("In <font face='Courier'>src/main/email/gmail.ts</font>, the OTP_PRESETS "
      "object has a query pattern per bank for finding OTP emails. Add one for IDFC:", story)
    CODE("""IDFC_BANK: {
  query: 'from:(@idfcfirstbank.com) subject:(OTP OR login OR verification)',
  otpRegex: /\\b(\\d{6})\\b/,
},""", story)
    P("And map it in registry.ts:", story)
    CODE("""const OTP_PRESET_BY_CODE = {
  AU:   OTP_PRESETS.AU_BANK,
  // ...
  IDFC: OTP_PRESETS.IDFC_BANK,
};""", story)

    H2("12.8 Add to the BANKS constant in the renderer", story)
    P("Open <font face='Courier'>src/renderer/src/pages/Dashboard.tsx</font>, find "
      "the BANKS array, and add 'IDFC':", story)
    CODE("const BANKS = ['AU', 'YES', 'SBI', 'KOTAK', 'ICICI', 'BOB', 'PNB', 'HDFC', 'AXIS', 'IDFC'];", story)
    P("Also add an abbreviation in the BANK_ABBR map, e.g. <font face='Courier'>IDFC: 'IF'</font>, "
      "and add a logo PNG to <font face='Courier'>src/renderer/src/assets/logos/idfc.png</font> "
      "+ import in the BANK_LOGOS map.", story)

    H2("12.9 Build and test", story)
    CODE("""npm run build
# or for a packaged installer:
npm run build:win""", story)
    P("Open the app, add an IDFC bank account to one member, click the IDFC "
      "chip. Watch the browser open and execute your selectors. If anything is "
      "off, the diagnostic dump in the adapter logs the visible buttons and "
      "inputs at the failure point.", story)

    H2("12.10 Common gotchas", story)
    B([
        "<b>Multi-box OTP fields</b> — many banks render OTP as 6 separate boxes "
        "instead of one input. The Dhan + Angel adapters have helper functions "
        "(fillDigits) that handle this — copy-adapt from there.",
        "<b>iframe wrappers</b> — some banks load the login form in an iframe. "
        "page.frameLocator() is your tool.",
        "<b>Slow load times</b> — increase waitForSelector timeouts to 30s if the "
        "bank is slow.",
        "<b>Random splash screens</b> — some banks show a welcome modal that you "
        "have to dismiss. Add a 'dismissOverlay' helper.",
        "<b>Re-login required after balance fetch</b> — some banks log you out after "
        "30 seconds of inactivity. fetchBalance has to navigate to the balance page "
        "directly, not via menus.",
    ], story)


def section_part13_patterns(story):
    H1("Part 13 — Common Patterns in the Codebase", story)
    P("Once you have read a few files, you will notice the same patterns "
      "repeating. Here are the most important ones.", story)

    H2("13.1 The IPC handler pattern", story)
    P("Every IPC handler in src/main/ipc.ts follows this shape:", story)
    CODE("""ipc.handle('something:action', async (_, payload) => {
  try {
    // 1) Validate the payload
    if (!payload?.requiredField) {
      return { ok: false, error: 'missing requiredField' };
    }

    // 2) Do the work
    const result = await doTheWork(payload);

    // 3) Return success with data
    return { ok: true, ...result };
  } catch (e) {
    // 4) Always return a structured error
    return { ok: false, error: e?.message || String(e) };
  }
});""", story)
    P("The {ok, error, data} shape is consistent across every handler. The "
      "renderer always knows to check result.ok before using result.data.", story)

    H2("13.2 The encrypted-field pattern", story)
    P("Every sensitive column is stored as a BLOB whose contents come from "
      "encryptField() and are read back via decryptField():", story)
    CODE("""// On write:
db.prepare('UPDATE bank_accounts SET password_enc = ? WHERE id = ?')
  .run(await encryptField(newPassword), bankId);

// On read:
const password = await decryptField(bankRow.password_enc);""", story)

    H2("13.3 The adapter interface pattern", story)
    P("Every bank/broker adapter implements the same TypeScript interface, "
      "LoginAdapter, defined in browser.ts:", story)
    CODE("""export interface LoginAdapter {
  code: string;
  displayName: string;
  otpMode?: 'email' | 'manual' | 'totp';

  login(page, creds, fetchOtp): Promise<void>;
  fetchBalance?(page): Promise<string | null>;
  downloadPortfolioReport?(page, creds, fetchOtp): Promise<DownloadedBrokerReport | null>;
  prepareIpoBid?(page, draft): Promise<PreparedIpoBidResult>;
  submitPreparedIpoBid?(page, draft): Promise<SubmittedIpoBidResult>;
}""", story)
    P("This interface is the contract. As long as you implement it correctly, "
      "the rest of the system treats your adapter identically to every other "
      "adapter. This is the power of abstraction.", story)

    H2("13.4 The bus / channel naming convention", story)
    P("IPC channels follow <font face='Courier'>domain:action</font>:", story)
    TABLE([
        ["Channel", "Domain", "Action"],
        ["vault:unlock", "vault", "unlock"],
        ["families:list", "families", "list"],
        ["member:fullDetail", "member", "fullDetail"],
        ["login:bank", "login", "bank"],
        ["backup:status", "backup", "status"],
        ["captchaAi:setKey", "captchaAi", "setKey"],
    ], story, col_widths=[5*cm, 5*cm, 6*cm])

    H2("13.5 The 'busy state' pattern in the renderer", story)
    P("To prevent double-clicks during async operations, every interactive part "
      "uses the busy state pattern:", story)
    CODE("""const [busy, setBusy] = useState(null);

async function doSomething() {
  setBusy('something-running');
  try {
    await window.api.something();
  } finally {
    setBusy(null);
  }
}

<button disabled={busy === 'something-running'}>
  {busy === 'something-running' ? 'Working...' : 'Click me'}
</button>""", story)

    H2("13.6 The toast notification pattern", story)
    P("Instead of alert() or console.log, the renderer uses a small toast "
      "queue. showToast(kind, message) shows a colored banner in the "
      "bottom-right for 5 seconds:", story)
    CODE("""showToast('success', 'AU balance refreshed: ₹1,23,456');
showToast('error', 'Could not connect to Gmail');
showToast('info', 'Backing up to OneDrive...');""", story)

    H2("13.7 The 'never throw, always return' contract", story)
    P("Inside IPC handlers, we never let an exception bubble up to the "
      "renderer. Always catch and return {ok: false, error: '...'}. This makes "
      "the frontend code simpler — it never needs try/catch around an IPC "
      "call.", story)

    H2("13.8 The 'sensitive data lives in BLOBs, display data lives in TEXT' pattern", story)
    P("Notice the schema: <font face='Courier'>pan_enc BLOB</font> (encrypted "
      "PAN) but <font face='Courier'>pan_last4 TEXT</font> (last 4 chars in "
      "plaintext for fast list rendering). Same for account numbers and Aadhaar. "
      "The plaintext last-4 is safe to leak in screenshots — the full value is "
      "always encrypted.", story)


def section_part14_data_flow(story):
    H1("Part 14 — Data Flow Diagrams", story)
    P("Sometimes ASCII diagrams help more than prose. Here are the data flows "
      "for the most important operations.", story)

    H2("14.1 The unlock flow", story)
    CODE("""User                Renderer               Main process           Disk / OS
 │                     │                       │                          │
 │  type password      │                       │                          │
 ├────────────────────>│                       │                          │
 │                     │  vault:unlock(pw)     │                          │
 │                     ├──────────────────────>│                          │
 │                     │                       │  read vault.meta.json    │
 │                     │                       ├─────────────────────────>│
 │                     │                       │<───── { saltHex, ... } ──┤
 │                     │                       │                          │
 │                     │                       │  Argon2id(pw, salt)      │
 │                     │                       │  ────────► (500ms)       │
 │                     │                       │  ◄──── 32-byte key       │
 │                     │                       │                          │
 │                     │                       │  open vault.db with key  │
 │                     │                       ├─────────────────────────>│
 │                     │                       │<──── DB ready ───────────┤
 │                     │                       │                          │
 │                     │<──── { ok: true } ────┤                          │
 │                     │                       │                          │
 │  see splash screen  │ render SplashScreen   │                          │
 │<────────────────────┤                       │                          │
 │                     │ Dashboard pre-loads   │  families:list           │
 │                     │ data behind splash    │  members:byFamily        │
 │                     ├──────────────────────>│  gmail:status            │
 │                     │                       │  backup:status           │
 │                     │<───── all results ────┤  ...                     │
 │                     │                       │                          │
 │  splash fades       │ unmount splash        │                          │
 │  dashboard visible  │                       │                          │
 │<────────────────────┤                       │                          │""", story)

    H2("14.2 The encrypted backup flow", story)
    CODE("""Main process              Backup folder            Disk
   │                            │                       │
   │  read vault.meta.json      │                       │
   ├────────────────────────────│──────────────────────>│
   │                            │                       │
   │  VACUUM INTO snapshot.db   │                       │
   ├────────────────────────────│──────────────────────>│
   │                            │                       │  (consistent
   │                            │                       │   SQLCipher
   │                            │                       │   encrypted copy)
   │                            │                       │
   │  read field key            │                       │
   ├────────────────────────────│──── keytar ──────────>│
   │<───────────────────────────│──── 32 bytes ─────────┤
   │                            │                       │
   │  AES-256-GCM-encrypt       │                       │
   │  field-key with master key │                       │
   │                            │                       │
   │  copy meta.json + db +     │                       │
   │  field-key.bin into        │                       │
   │  snapshots/<ts>/           │                       │
   ├───────────────────────────>│                       │
   │                            │                       │
   │  SELECT documents.file_uuid│                       │
   │  for each missing one      │                       │
   │  copy from data/documents/ │                       │
   │  to backup blobs/          │                       │
   ├───────────────────────────>│                       │
   │                            │                       │
   │  write manifest.json with  │                       │
   │  list of file_uuids        │                       │
   ├───────────────────────────>│                       │
   │                            │                       │
   │  retention sweep:          │                       │
   │  delete old snapshots      │                       │
   ├───────────────────────────>│                       │
   │                            │                       │
   │  GC: delete unreferenced   │                       │
   │  blobs                     │                       │
   ├───────────────────────────>│                       │""", story)

    H2("14.3 The CAPTCHA solve flow with cost gate", story)
    CODE("""Adapter                   ai/usage              Anthropic API
   │                            │                       │
   │  solveCaptcha(imageBytes)  │                       │
   │  reads stored API key      │                       │
   │                            │                       │
   │  canMakeCaptchaCall()      │                       │
   ├───────────────────────────>│                       │
   │                            │ check usage.json      │
   │                            │ - consented? Y        │
   │                            │ - today's count <     │
   │                            │   cap? Y              │
   │<──── { ok: true } ─────────┤                       │
   │                            │                       │
   │  POST /v1/messages         │                       │
   ├────────────────────────────│──────────────────────>│
   │                            │                       │
   │                            │                       │  (Claude sees
   │                            │                       │   the image,
   │                            │                       │   responds with
   │                            │                       │   6 characters)
   │                            │                       │
   │<───────────────────────────│───── 200 OK ──────────┤
   │  payload.content[0].text   │                       │
   │  payload.usage.input_tokens│                       │
   │  payload.usage.output_tokens                       │
   │                            │                       │
   │  recordCaptchaCall(in, out)│                       │
   ├───────────────────────────>│                       │
   │                            │ increment today's     │
   │                            │ counts in usage.json  │
   │                            │                       │
   │  return cleaned text       │                       │""", story)


def main():
    story = []

    section_cover(story)
    section_toc(story)
    section_preface(story)
    section_part1_big_picture(story)
    section_part2_concepts(story)
    section_part3_end_to_end(story)
    section_part4_folders(story)
    section_part5_libraries(story)
    section_part6_security(story)
    section_part7_features(story)
    section_part8_limitations(story)
    section_part9_risks(story)
    section_part10_one_click(story)
    section_part11_glossary(story)
    section_part12_add_bank(story)
    section_part13_patterns(story)
    section_part14_data_flow(story)
    section_appendix_a(story)
    section_appendix_b(story)
    section_closing(story)

    doc = GuideDocTemplate(
        str(OUT_PATH),
        pagesize=A4,
        leftMargin=1.7 * cm,
        rightMargin=1.7 * cm,
        topMargin=1.8 * cm,
        bottomMargin=2.0 * cm,
        title="IPO Manager — Learning Guide",
        author="Built with Claude (Anthropic)",
    )

    # multiBuild runs the doc twice so the TOC's page numbers settle.
    doc.multiBuild(story)
    print(f"Wrote {OUT_PATH}  ({OUT_PATH.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == '__main__':
    main()
