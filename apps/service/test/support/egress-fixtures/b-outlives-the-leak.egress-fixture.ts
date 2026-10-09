it('is still running when the leaked timer fires', () =>
  new Promise<void>((resolve) => setTimeout(resolve, 1_000)));
