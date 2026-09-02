# Modules

One folder per business module. Nothing here yet — the skeleton ships with the
health route only.

## Shape of a module

Each module folder holds five files, in dependency order:

```
modules/<name>/
├── <name>.model.ts       Mongoose schema + model. Types the document.
├── <name>.validation.ts  Zod schemas for create/update payloads and queries.
├── <name>.service.ts     Business logic and database access. No req/res here.
├── <name>.controller.ts  Reads the request, calls the service, sendResponse.
└── <name>.route.ts       Router: path + middleware chain + controller.
```

## Rules

- **The service layer never touches `req` or `res`.** It takes plain arguments
  and returns plain data, so it stays testable and reusable.
- **The controller never contains business logic.** It unpacks the request,
  delegates, and formats the reply through `sendResponse`.
- **Validation happens in middleware**, via `validateRequest({ body: schema })`,
  not inside the controller.
- **Every route that touches the database mounts `requireDb`.** The HTTP server
  starts before MongoDB connects, so this is what turns an outage into a clean
  503 instead of a hung request.
- **Write plain `async` handlers and throw.** Express 5 forwards rejected
  promises to the error handler automatically — no `catchAsync` wrapper.
- Register the module's router in `src/routes/index.ts`.

## Example route

```ts
router.post(
  '/',
  auth,
  requireDb,
  validateRequest({ body: createThingSchema }),
  createThing,
)
```
