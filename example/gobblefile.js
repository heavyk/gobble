var gobble = require( '../' );

module.exports = gobble([

	// the main index.html file, and the turkey logo
	gobble( 'src/root' ),
	
	gobble( 'src/lala.txt' ),

	// styles - convert from SCSS to CSS using the gobble-sass plugin
	gobble( 'src/styles' ).transform( 'sass', { src: 'main.scss', dest: 'main.css' }),

	// coffeescript - convert to javascript, then minify
	gobble( 'src/coffee' ).transform( 'coffee' ).transform( 'uglifyjs' ).transform( 'sorcery' )

]);

process.on('uncaughtException', function (err) {
	console.log('unhandled', err.stack)
})

process.on("unhandledRejection", function(reason, p){
  console.log("Unhandled", reason, p); // log all your errors, "unsuppressing" them.
  throw reason; // optional, in case you want to treat these as errors
});
