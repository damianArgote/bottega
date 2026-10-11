# Content

Editable content the bot uses as knowledge. It is loaded and validated once at
boot (`src/content/content.service.ts`); an invalid file stops the application
with an error naming the file and the problem. Restart the app after editing.

| File | Used in | Format |
|------|---------|--------|
| `commercial-info.md` | Commercial mode | Markdown. The top `<!-- -->` comment holds editing notes and is not passed to the bot. Must not be empty. Keep `[COMPLETAR]` where data is not confirmed: the bot answers that the team will confirm it. |
| `demos/barbershop.json` | Demo mode | JSON. Fictitious barbershop: `scenario`, `fictitious: true` (required), `name`, `description`, `address`, `currency` (`ARS`), `services` (`name`, `priceArs`, `durationMinutes`), `openingHours` (`days`, `hours`), `faq` (`question`, `answer`), `bookingFields` (subset of `customerName`, `service`, `preferredDate`, `preferredTime`). Unknown keys are rejected. |

Never put secrets, personal data, or invented real-world claims (prices,
clients, testimonials, results) in these files.
