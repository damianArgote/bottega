# Content

Editable content the bot uses as knowledge. It is loaded and validated once at
boot (`src/content/content.service.ts`); an invalid file stops the application
with an error naming the file and the problem. Restart the app after editing.

| File | Used in | Format |
|------|---------|--------|
| `commercial-info.md` | Initial `businessInfo` of BotSuite46's agent profile, copied once when `seed:default-line` creates the profile (later edits to this file do not reach a profile that already exists) | Markdown. The top `<!-- -->` comment holds editing notes and is not passed to the bot. Must not be empty. Keep `[COMPLETAR]` where data is not confirmed: the bot answers that the team will confirm it. |
| `demos/insurance.json` | Demo mode, "Seguro de auto" | JSON. Car insurance demo: `scenario: "insurance"`, `fictitious: true` (required), `name`, `description`, `currency` (`ARS`), `minYear`, `gncSurchargePercent`, `zones` (`name`, `factorPercent`), `vehicles` (`make`, `model`, `versions`, `category` `A`/`B`/`C`), `plans` (1 to 3: `name`, `summary`, `coverages`, `notIncluded`, `deductibleArs` or null, `conditions`, `monthlyArs` per category, `maxVehicleAgeYears` or null). Monthly price = plan price for the car's category × zone factor (+ GNC surcharge), rounded to hundreds. Unknown keys are rejected. |
| `demos/barbershop.json` | Demo mode, "Barbería" | JSON. Fictitious barbershop: `scenario`, `fictitious: true` (required), `name`, `description`, `address`, `currency` (`ARS`), `services` (`name`, `priceArs`, `durationMinutes`), `openingHours` (`days`, `hours`), `faq` (`question`, `answer`), `bookingFields` (subset of `customerName`, `service`, `preferredDate`, `preferredTime`). Unknown keys are rejected. |

Never put secrets, personal data, or invented real-world claims (prices,
clients, testimonials, results) in these files.
