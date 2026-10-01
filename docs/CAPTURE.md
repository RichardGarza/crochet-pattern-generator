# How to photograph an object for the 3D mode

The app turns photos of an object into a 3D model and then into a crochet pattern. Before the first release it
has to be checked against **real phone photos**, not only computer-made test pictures. This page says which
photos are needed and how to take them (`DESIGN.md` §6.2, release gates 2 and 4 in §6.5).

## What is needed

Three objects, one small folder of photos each:

| # | Object | Why |
|---|---|---|
| 1 | A **plush toy** (a teddy bear or similar: body, head, limbs) | parts, head and body split, limbs |
| 2 | A **striped or spotted** object (a striped mug, a spotted ball, a toy with clear color bands) | colors and patterns carried onto the 3D shape |
| 3 | A **simple round** object (an orange, a ball, an egg-shaped ornament) | the basic shape and its size |

## The photos

Take **3 to 5 photos per object**, each from one side, and name them by what they show:

| File name | Shows | Needed? |
|---|---|---|
| `1-front.jpg` | the object's front | yes |
| `2-left.jpg` | the object's **own** left side (the side its left arm is on) | yes |
| `3-top.jpg` | straight down from above, with the object's front toward the bottom of the photo | yes |
| `4-right.jpg` | the object's own right side | optional |
| `5-back.jpg` | the back | optional |

JPEG or HEIC straight from the phone is fine; keep the number and the view in the name (`1-front.heic` is as
good as `1-front.jpg`). Do not edit, crop or filter the photos.

## How to take them

1. **Background:** plain and in a color that contrasts with the object — a sheet of paper, a wall, a bedsheet.
   No pattern, no clutter.
2. **Light:** soft and even: daylight near a window, or a room light that is not pointing straight at the
   object. Avoid a hard, dark shadow.
3. **Distance:** stand **1.5 to 2 m (5 to 6.5 ft) away and zoom in 2–3×**. Close-up photos bend the shape;
   stepping back and zooming keeps it true.
4. **Height:** hold the camera level with the **middle** of the object, not above it (except for the top photo).
5. **Framing:** the whole object in the picture, with empty space on every side — at least a tenth of the
   picture's width and height. Nothing may be cut off.
6. **Turn the object, not the camera:** after each photo turn the object a quarter turn (90°) and keep the
   camera where it is.
7. **Nothing else touching it:** no hand holding it, nothing leaning on it.

## Where to put them

One folder per object, with a short `README.md`:

```
fixtures/images/3d/real/
  plush/
    1-front.jpg
    2-left.jpg
    3-top.jpg
    README.md
  striped/
    ...
  round/
    ...
```

The `README.md` says, in a few lines: what the object is, how tall it is in inches, and its colors, for example:

```
A brown teddy bear, 9 inches tall. Brown body, cream muzzle and paw pads, black eyes and nose.
```

## Privacy

These photos **stay on this computer**. The whole `fixtures/images/3d/real/` folder is ignored by git, except
each object's `README.md` and `expected.json` (a short list of what the app should find: number of parts, colors,
stripes or spots). The repository is public, and phone photos carry the place and time they were taken, so:

- nothing in that folder is uploaded unless you say so;
- if a photo is ever to be shared, it is first copied without its hidden data
  (`node scripts/strip-exif.mjs <photo>`), and a test refuses any committed image that still carries it.

## What happens with them

For each object the app must reach a finished pattern with no errors and match the object's `expected.json`
(part count and names, the outline seen from each side, the colors, the stripes or spots). A side-by-side picture
— photo, rebuilt model, pattern shape — is saved for you to look at and approve. One of the sets is also used to
check the optional "Add depth detail" step.
