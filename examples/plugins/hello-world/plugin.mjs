export async function activate() {
  return {
    operations: {
      greet(args) {
        const name = args.name?.trim() || "world";
        return { greeting: `Hello, ${name}!`, harmless: true };
      },
    },
  };
}
