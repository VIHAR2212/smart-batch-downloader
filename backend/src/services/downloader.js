if (process.env.YOUTUBE_COOKIES) {
  const cookiePath = path.join(config.TEMP_DIR, 'yt-cookies.txt');
  fs.writeFileSync(cookiePath, process.env.YOUTUBE_COOKIES);
  args.push('--cookies', cookiePath);
}
