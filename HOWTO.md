# Komiq Typesetter: How To

Komiq Typesetter is beta software. It is a direct sibling tool of the Komiq Cleaner software.

This software is intended to make translation easier and to replace reliance on heavy professional tools like Photoshop, which are extremely resource consuming, and where installation and setup of pirated copies is too complicated and risky.

Komiq Typesetter takes little memory. It can work on a project with hundreds of pages and consume less than a gigabyte of memory by smartly offloading things to disk.

The ultimate goal is to fight against AI-only automated translations by making translation easier and more accessible.

This software is in its functional public beta. It is a WIP with heavy upgrades planned.

## Home screen

### Projects

You can create projects. Think of projects as series; you can create chapters under projects. During project creation you need to select whether the series is a longstrip (manhwa, manhua) or a manga (single page). This setting is persisted and currently not changeable.

During chapter creation, you need to select the raw and cleaned files, as well as a translated JSON if a translator provided one.

You also need to choose whether the chapter you will be working on is for typesetting or translating.

Translate mode only has the raw pages, Japanese detection tools, and the ability to create the translations per bubble and give them tags (optional, tags are explained below). Translate mode is created with translators (those who do not typeset) in mind. It is ultimately a watered down version of typeset mode.

Typeset mode offers everything, from text detection to translation, tagging, and so on.

## Editor

Raw pages are on the left, and the panel is hideable. On the top left of the cleaned page are the cursor mode options:

- **Paste mode** (pointer icon): pastes the next queued text on the place your pointer clicks.
- **Text mode** (T icon): creates a text box on the place you click.
- **Pan mode** (pan icon): good ol' pan mode.

More modes:

- **Bulk mode** (top right): this mode allows you to change specific settings of a tag or of text boxes you click, project wide or page wise. Made because I change my mind midway through translating; also handy in other cases.

**Text options menu**: just a normal, regular text options menu. Currently it only has font roughening options (though in a "just works" version). Gradient, text opacity, text blur, text jumping, and so on will be added to meet every need possible. But trying to add PSD support really hampers my creativity. I have an extremely mature text manipulation engine from another project of mine, and I will try to integrate it here.

**Text queue**: queued texts. Either you translate every page first, one by one, or use the JSON. Or do it as you go. Handy tagging system.

**Tagging system**: you can create a tag and attach it to a text box when writing the English translation (available in both modes). Tags have an option bar which allows you to select specific fonts for that tag. Less useful if you use the same font everywhere, but it can be used to differentiate SFX, side text, and so on.

**Smart font management system**: after you select a font, you are allowed to choose all of its typefaces from the font menu (top right). This way, you do not have to scroll fonts every time you need to use a different typeface; you can just select "italic", "bold", or "bold italic" from the text options menu. If no specific font is selected for the other typefaces, a faux typeface (programmatic typeface) will be used.

Good luck! Community feedback and feature requests are wanted, and contribution is loved!
