# Tulips Cafe menu — transcription, 3 Oct 2026

Source: the owner's three photos of the Tulips counter boards, taken 1 Oct 2026
(`D:\OWN Projects\Echo Echo\tulips menu\IMG_20261001_151150045_HDR.jpg`,
`…151202565_HDR.jpg`, `…151208548_HDR.jpg`; not committed). The boards are
photographed through the window, so each was read again from a full-resolution
crop before it was entered.

Prices are the board prices, unchanged. The ₹10 ECHO ECHO platform fee is charged
on the order by the pricing policy and is not part of any item price. (Chai
Garam's menu, loaded by migration 026, is board price + ₹10 on the owner's
instruction of 27 Sep; this menu does not follow that rule.)

Loaded by `server/src/db/030_tulips_menu.sql`: 24 items in 7 sections, all
available.

| Section | Item | ₹ | Board mark |
|---|---|---:|---|
| Speciality Drinks | Peach Ice Tea | 45 | — |
| Speciality Drinks | Lemon Ice Tea | 45 | — |
| Speciality Drinks | Nimbupani Masala | 35 | — |
| Speciality Drinks | Blueberry Lassi | 45 | — |
| Speciality Drinks | Cold Coffee | 55 | — |
| Speciality Drinks | Hazelnut Coffee | 55 | — |
| Softy (full cream) | Chocolate / Vanilla / Choco Vanilla Softy | 55 each | — |
| Sundae | Chocolate / Mango / Strawberry Sundae | 59 each | — |
| Slush | Blue Lagoon / Mojito Green Slush | 49 each | — |
| Hot Dog (fresh milk bun) | Chilly Paneer | 69 | Veg |
| Hot Dog | Pasta Bun | 79 | Veg |
| Hot Dog | Chicken Salami Salad | 89 | Chicken |
| Hot Dog | Chicken Seekh Kebab | 99 | Chicken |
| Sandwich (multigrain, no maida) | Batata Vada | 55 | Veg |
| Sandwich | Cheese Salad | 65 | Veg |
| Sandwich | Chicken Afghani Spread | 89 | Chicken |
| Sandwich | Chicken Ham n Cheese | 99 | Chicken |
| Rice Bowl | Chicken Keema ("Amritsari" chicken keema masala, boiled egg, basmati rice, green chutney, onion salad) | 120 | Non veg |
| Rice Bowl | Rajma Masala ("Jammu" Chitra rajma masala, shot of curd, basmati rice, green chutney, pickle, salad) | 80 | Veg |

## How the board was turned into items

- One price shared by several flavours (Ice Tea, Cold/Hazelnut Coffee, Softy,
  Sundae, Slush) became one item per flavour at that price.
- Hot dog and sandwich names carry their section ("Chilly Paneer Hot Dog") so a
  cart line is unambiguous; the board's own short name is stored as an alias.
- The veg flag is set only where the board says Veg, Chicken or Non veg. Drinks
  and desserts have no mark on the board and are left unmarked (NULL).
- "Masala Lemonade" is stored as an alias of Nimbupani Masala because the board
  labels that drink "Lemonade" in its artwork.

## Unresolved or excluded

Nothing. Every name and price on the three boards was legible. The canned soft
drinks visible in the fridge have no price on any board and were not added.
